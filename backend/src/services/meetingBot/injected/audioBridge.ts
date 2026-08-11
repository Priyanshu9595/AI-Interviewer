/**
 * The script the bot injects into the Google Meet page before Meet's own code
 * runs. It is the whole audio architecture, and it is worth being explicit
 * about why it is shaped this way.
 *
 * OUTPUT — the AI's voice into the meeting
 *   A meeting participant speaks through whatever `getUserMedia` handed the
 *   page. So the bridge replaces `getUserMedia` with one that returns a
 *   `MediaStreamAudioDestinationNode` it owns. Meet treats that node as the
 *   microphone; the bot writes synthesised speech into it. No sound card, no
 *   virtual cable, no operating-system configuration.
 *
 * INPUT — the candidate's voice out of the meeting
 *   Three taps, tried in order, because the three platforms deliver remote
 *   audio in three different ways:
 *
 *     1. `RTCPeerConnection` — wrapped so every inbound audio track is tapped
 *        as it is added. This is how Google Meet and Teams work, and it is the
 *        cleanest: the samples are read before they reach any speaker.
 *
 *     2. Web Audio — `AudioNode.connect` is wrapped so anything the page routes
 *        to a speaker is also routed to the bridge. Zoom's web client decodes
 *        audio in WebAssembly and plays it through its own `AudioContext`, so
 *        no remote track ever exists for tap 1 to find.
 *
 *     3. Media elements — `<audio>`/`<video>` are captured with
 *        `captureStream()`, for clients that simply attach a stream and play it.
 *
 *   Taps 2 and 3 stay dormant until Node says otherwise. Enabling them
 *   unconditionally would double-count on platforms where tap 1 already works —
 *   the same voice arriving twice, at twice the amplitude.
 *
 *   Everything is mixed, downsampled to 16 kHz mono, and handed to Node in
 *   small frames for Deepgram.
 *
 * The two directions never touch: `outGain` feeds only the synthetic
 * microphone, `inMixer` is fed only by whatever the taps find.
 */

export interface AudioBridgeConfig {
  /**
   * Replace the page's microphone with a stream the bot writes into. False for
   * the virtual-cable path, where a real device carries the AI's voice and the
   * page must be allowed to open it normally.
   */
  injectMicrophone: boolean;
  /** Sample rate handed to Deepgram. 16 kHz is its native rate for speech. */
  outputSampleRate: number;
  /** How much audio to gather before sending a frame to Node. */
  frameMs: number;
}

/**
 * Builds the injected source.
 *
 * Written as ES5 in a plain string on purpose: it runs before Meet's own
 * bundle, inside a page whose Content-Security-Policy will not load a module,
 * and it must not depend on anything the page provides.
 */
export function audioBridgeScript(config: AudioBridgeConfig): string {
  return `(function () {
  'use strict';

  var CFG = ${JSON.stringify(config)};
  if (window.__meetBot) return;

  var B = {
    ctx: null,
    outGain: null,
    outDest: null,
    inMixer: null,
    /** Tail of the filter chain the recogniser reads from. */
    filtered: null,
    processor: null,
    sink: null,
    playhead: 0,
    voices: [],
    micTracks: [],
    micInjected: false,
    remoteTracks: 0,
    seen: {},
    keepAlive: [],
    pending: [],
    pendingSamples: 0,
    errors: [],
    // Which taps have actually delivered audio, so a silent interview can be
    // diagnosed from the outside instead of guessed at.
    stats: { rtc: 0, webaudio: 0, element: 0, frames: 0, peak: 0 },
    fallbackEnabled: false,
    // One bridging destination per foreign AudioContext. Nodes cannot be
    // connected across contexts, so each one needs its own crossing point.
    foreignContexts: [],
    foreignBridges: [],
    // Nodes seen routing to a speaker before the fallback was switched on.
    observed: [],
    elementScan: null
  };
  window.__meetBot = B;

  function report(type, detail) {
    try {
      if (window.__meetBotEvent) window.__meetBotEvent(JSON.stringify({ type: type, detail: detail || null }));
    } catch (e) { /* the binding is not installed in this frame */ }
  }

  function fail(where, err) {
    var message = where + ': ' + ((err && err.message) || err);
    B.errors.push(message);
    report('error', message);
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  function ensureCtx() {
    if (B.ctx) return B.ctx;

    var Ctor = window.AudioContext || window.webkitAudioContext;
    B.ctx = new Ctor({ sampleRate: 48000 });

    B.outGain = B.ctx.createGain();
    B.outGain.gain.value = 1;
    B.outDest = B.ctx.createMediaStreamDestination();
    B.outGain.connect(B.outDest);

    // A silent source that never stops. Chrome will let an outgoing track that
    // produces nothing at all fall idle, and Meet then shows the bot as muted
    // between questions.
    var dc = B.ctx.createConstantSource();
    dc.offset.value = 0;
    dc.connect(B.outGain);
    dc.start();

    B.playhead = B.ctx.currentTime;
    if (B.ctx.state === 'suspended') B.ctx.resume().catch(function () {});
    return B.ctx;
  }

  // -------------------------------------------------------------------------
  // Output: synthetic microphone
  // -------------------------------------------------------------------------

  function blackVideoTrack() {
    var canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    var g = canvas.getContext('2d');
    g.fillStyle = '#000000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    // captureStream only emits frames while the canvas is being painted.
    setInterval(function () { g.fillRect(0, 0, canvas.width, canvas.height); }, 1000);
    return canvas.captureStream(1).getVideoTracks()[0];
  }

  function syntheticStream(constraints) {
    ensureCtx();
    var stream = new MediaStream();

    // Clone per call: Meet stops the track it was given when the user toggles
    // the microphone, and a stopped source track could not be handed out again.
    var source = B.outDest.stream.getAudioTracks()[0];
    var track = source.clone();
    B.micTracks.push(track);
    stream.addTrack(track);

    if (constraints && constraints.video) stream.addTrack(blackVideoTrack());

    B.micInjected = true;
    return stream;
  }

  if (CFG.injectMicrophone && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = function (constraints) {
      try {
        constraints = constraints || {};
        // A video-only request is the camera preview; leave it alone so the
        // pre-join screen behaves normally and the bot can switch it off.
        if (!constraints.audio) return realGetUserMedia(constraints);

        report('microphone_injected');
        return Promise.resolve(syntheticStream(constraints));
      } catch (err) {
        fail('getUserMedia', err);
        return realGetUserMedia(constraints);
      }
    };

    // Some Meet builds still probe the prefixed entry point first.
    navigator.getUserMedia = function (constraints, onSuccess, onError) {
      navigator.mediaDevices.getUserMedia(constraints).then(onSuccess, onError);
    };
  }

  // -------------------------------------------------------------------------
  // Input: tap remote audio
  // -------------------------------------------------------------------------

  function ensureRecorder() {
    if (B.processor) return;

    var ctx = ensureCtx();
    B.inMixer = ctx.createGain();
    B.inMixer.gain.value = 1;

    // Two high passes between the meeting and the recogniser, aimed at the
    // noise a candidate cannot do anything about: mains hum, a desk fan, air
    // conditioning, traffic, the knock of a laptop on a table. None of it
    // carries a word, and all of it is loud enough to hold voice detection
    // open through the pauses and to drag the recogniser's gain down.
    //
    // Two stages at 120 Hz rather than one lower down, measured across the
    // band:
    //
    //     50 Hz  -28.9 dB     120 Hz  +1.0 dB     1 kHz  +0.1 dB
    //     60 Hz  -22.0 dB     200 Hz  +2.7 dB     3 kHz   0.0 dB
    //    100 Hz   -3.4 dB     300 Hz  +1.4 dB
    //
    // Mains and fan noise are gone; speech is untouched above 1 kHz. The few
    // dB of lift around 200 Hz is the cascade's own passband ripple, and it is
    // left in — it sits where a low voice carries, and flattening it cost more
    // rumble rejection than it was worth.
    //
    // A low shelf was tried here too and taken out again: it removed 2 dB of
    // rumble and about as much of the voice with it.
    var highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 120;
    highPass.Q.value = 0.5;

    var highPass2 = ctx.createBiquadFilter();
    highPass2.type = 'highpass';
    highPass2.frequency.value = 120;
    highPass2.Q.value = 0.5;

    // Marked like the rest of the bridge's plumbing so the Web Audio tap does
    // not mistake these for meeting audio and feed them round again.
    highPass.__meetBotInternal = true;
    highPass2.__meetBotInternal = true;

    B.inMixer.connect(highPass);
    highPass.connect(highPass2);
    B.filtered = highPass2;

    var processor = ctx.createScriptProcessor(4096, 1, 1);
    var ratio = ctx.sampleRate / CFG.outputSampleRate;
    var frameSamples = Math.round(CFG.outputSampleRate * (CFG.frameMs / 1000));

    processor.onaudioprocess = function (event) {
      try {
        var input = event.inputBuffer.getChannelData(0);
        var outLength = Math.floor(input.length / ratio);
        var out = new Int16Array(outLength);

        // Loudest sample seen, so "we are capturing but it is pure silence"
        // can be told apart from "nothing is connected at all".
        for (var p = 0; p < input.length; p += 16) {
          var a = input[p] < 0 ? -input[p] : input[p];
          if (a > B.stats.peak) B.stats.peak = a;
        }

        for (var i = 0; i < outLength; i++) {
          // Average the samples folding into each output sample. Dropping every
          // third one instead would alias sibilants into the speech band and
          // measurably hurt transcription.
          var start = Math.floor(i * ratio);
          var end = Math.floor((i + 1) * ratio);
          var sum = 0;
          var n = 0;
          for (var j = start; j < end && j < input.length; j++) { sum += input[j]; n++; }
          var v = n ? sum / n : 0;
          if (v > 1) v = 1; else if (v < -1) v = -1;
          out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }

        B.pending.push(out);
        B.pendingSamples += outLength;
        if (B.pendingSamples >= frameSamples) flush();
      } catch (err) {
        fail('onaudioprocess', err);
      }
    };

    // Fed from the filtered end of the chain, not from the mixer directly.
    B.filtered.connect(processor);

    // A ScriptProcessor only runs while it reaches the destination. The gain
    // stage is silent, so nothing is played back — the browser is muted anyway,
    // but routing candidate audio to a speaker would invite an echo.
    var sink = ctx.createGain();
    sink.gain.value = 0;
    // Marked so the Web Audio tap below does not treat the bridge's own
    // plumbing as meeting audio and feed it back into itself.
    sink.__meetBotInternal = true;
    processor.__meetBotInternal = true;
    B.inMixer.__meetBotInternal = true;
    processor.connect(sink);
    sink.connect(ctx.destination);

    B.processor = processor;
    B.sink = sink;
  }

  function flush() {
    if (!B.pendingSamples) return;

    var merged = new Int16Array(B.pendingSamples);
    var offset = 0;
    for (var i = 0; i < B.pending.length; i++) {
      merged.set(B.pending[i], offset);
      offset += B.pending[i].length;
    }
    B.pending = [];
    B.pendingSamples = 0;

    var bytes = new Uint8Array(merged.buffer);
    var binary = '';
    // String.fromCharCode.apply blows the argument limit on a large array.
    for (var k = 0; k < bytes.length; k += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    }

    try {
      if (window.__meetBotAudio) window.__meetBotAudio(btoa(binary));
      B.stats.frames++;
    } catch (err) {
      fail('audio binding', err);
    }
  }

  /**
   * Routes one incoming stream into the capture mixer.
   *
   * Shared by all three taps. Deduplicated by track id so a stream that arrives
   * through two of them at once is only mixed in once.
   */
  function attachStream(stream, origin) {
    if (!stream) return;

    var tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (!track || B.seen[track.id]) continue;
      B.seen[track.id] = true;

      try {
        var ctx = ensureCtx();
        ensureRecorder();

        var single = new MediaStream([track]);

        // Chrome does not pump a remote track into Web Audio until the stream
        // is also attached to a media element. The element is muted and hidden;
        // it exists only to start the flow.
        var el = document.createElement('audio');
        el.srcObject = single;
        el.muted = true;
        el.autoplay = true;
        el.setAttribute('data-meet-bot', '1');
        (document.body || document.documentElement).appendChild(el);
        el.play().catch(function () {});
        B.keepAlive.push(el);

        var source = ctx.createMediaStreamSource(single);
        source.__meetBotInternal = true;
        source.connect(B.inMixer);

        B.remoteTracks++;
        B.stats[origin] = (B.stats[origin] || 0) + 1;
        report('audio_attached', origin + ':' + track.id);

        (function (src, element, id) {
          track.addEventListener('ended', function () {
            try { src.disconnect(); } catch (e) {}
            try { element.remove(); } catch (e) {}
            B.remoteTracks--;
            report('audio_ended', origin + ':' + id);
          });
        })(source, el, track.id);
      } catch (err) {
        fail('attachStream(' + origin + ')', err);
      }
    }
  }

  function attachRemote(track) {
    if (!track || track.kind !== 'audio') return;
    attachStream(new MediaStream([track]), 'rtc');
  }

  // -------------------------------------------------------------------------
  // Fallback taps, dormant until Node asks for them
  // -------------------------------------------------------------------------

  var nativeConnect = window.AudioNode && window.AudioNode.prototype && window.AudioNode.prototype.connect;

  /**
   * Watches Web Audio routing from the very first moment, but only records it.
   *
   * The tap itself stays off until Node asks for it, yet the *observation* has
   * to start immediately: a client wires its audio graph up once, when it joins
   * audio, which is well before the twelve seconds of silence that trigger the
   * fallback. Waiting until then to install this hook would mean the graph was
   * already connected and there would be nothing left to see.
   */
  if (nativeConnect) {
    window.AudioNode.prototype.connect = function (destination) {
      var result = nativeConnect.apply(this, arguments);

      try {
        var isSpeaker =
          destination &&
          typeof window.AudioDestinationNode !== 'undefined' &&
          destination instanceof window.AudioDestinationNode;

        if (isSpeaker && !this.__meetBotInternal) {
          if (B.fallbackEnabled) {
            tapWebAudioNode(this);
          } else if (B.observed.indexOf(this) < 0) {
            // Remembered now, tapped later if it turns out we are deaf.
            B.observed.push(this);
          }
        }
      } catch (e) { /* never break the page's own audio */ }

      return result;
    };
  }

  /**
   * Bridges a foreign AudioContext into ours.
   *
   * Zoom decodes audio in WebAssembly and plays it through an AudioContext of
   * its own. Nodes cannot be connected across contexts, so the only way across
   * is a MediaStream: a destination node created *in their context*, whose
   * stream is then read as a source in ours.
   */
  function bridgeContext(ctx) {
    var index = B.foreignContexts.indexOf(ctx);
    if (index >= 0) return B.foreignBridges[index];

    var bridge = ctx.createMediaStreamDestination();
    bridge.__meetBotInternal = true;
    B.foreignContexts.push(ctx);
    B.foreignBridges.push(bridge);

    attachStream(bridge.stream, 'webaudio');
    report('webaudio_context_bridged');
    return bridge;
  }

  function tapWebAudioNode(node) {
    try {
      if (!node || node.__meetBotTapped || node.__meetBotInternal) return;
      if (!node.context || node.context === B.ctx) return; // our own graph
      node.__meetBotTapped = true;
      nativeConnect.call(node, bridgeContext(node.context));
    } catch (err) {
      fail('tapWebAudioNode', err);
    }
  }

  function tapMediaElement(el) {
    try {
      if (!el || el.__meetBotTapped) return;
      if (el.getAttribute && el.getAttribute('data-meet-bot') === '1') return; // ours
      if (!el.srcObject && !el.currentSrc && !el.src) return;

      el.__meetBotTapped = true;

      // captureStream is non-destructive, unlike createMediaElementSource,
      // which would re-route the element and silence the page's own playback.
      var capture = el.captureStream || el.mozCaptureStream;
      if (!capture) return;

      var stream = capture.call(el);
      if (stream && stream.getAudioTracks && stream.getAudioTracks().length) {
        attachStream(stream, 'element');
      } else {
        el.__meetBotTapped = false; // no audio yet; try again on the next scan
      }
    } catch (err) {
      fail('tapMediaElement', err);
    }
  }

  function scanMediaElements() {
    var elements = document.querySelectorAll('audio, video');
    for (var i = 0; i < elements.length; i++) tapMediaElement(elements[i]);
  }

  /**
   * Turns on taps 2 and 3.
   *
   * Called by Node when the WebRTC tap has produced nothing, which is the
   * signal that this platform does not deliver remote audio as a track.
   */
  B.enableFallbackCapture = function () {
    if (B.fallbackEnabled) return B.stats;
    B.fallbackEnabled = true;
    report('fallback_capture_enabled');

    ensureCtx();
    ensureRecorder();

    // Everything already wired to a speaker. This is the important half for
    // Zoom: its graph was connected minutes ago and will not be reconnected.
    for (var i = 0; i < B.observed.length; i++) tapWebAudioNode(B.observed[i]);
    B.observed = [];

    scanMediaElements();
    if (!B.elementScan) B.elementScan = setInterval(scanMediaElements, 3000);

    return B.stats;
  };

  (function hookPeerConnection() {
    var Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Native) return;

    function Wrapped(configuration, constraints) {
      var pc = new Native(configuration, constraints);
      pc.addEventListener('track', function (event) { attachRemote(event.track); });
      return pc;
    }

    Wrapped.prototype = Native.prototype;

    // Meet reads statics off the constructor — generateCertificate above all —
    // and a bare copy would call them with the wrong receiver.
    Object.getOwnPropertyNames(Native).forEach(function (key) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === 'caller' || key === 'arguments') return;
      try {
        var value = Native[key];
        Wrapped[key] = typeof value === 'function' ? value.bind(Native) : value;
      } catch (e) { /* non-configurable */ }
    });

    window.RTCPeerConnection = Wrapped;
    window.webkitRTCPeerConnection = Wrapped;
  })();

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  /**
   * Queues one chunk of PCM for playback into the meeting and returns how many
   * seconds of speech are still outstanding.
   *
   * Chunks are butted end to end against a playhead rather than played on
   * arrival, so a sentence streamed as twenty small pieces is heard as one
   * continuous utterance.
   */
  B.speak = function (base64, sampleRate) {
    try {
      var ctx = ensureCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});

      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
      if (!pcm.length) return B.remaining();

      var samples = new Float32Array(pcm.length);
      for (var j = 0; j < pcm.length; j++) samples[j] = pcm[j] / 32768;

      var buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);

      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(B.outGain);

      var now = ctx.currentTime;
      // A small lead when the queue has drained absorbs scheduling jitter; if
      // audio is still playing, append exactly at its end.
      var startAt = B.playhead > now + 0.02 ? B.playhead : now + 0.08;
      source.start(startAt);
      B.playhead = startAt + buffer.duration;

      B.voices.push(source);
      source.onended = function () {
        var idx = B.voices.indexOf(source);
        if (idx >= 0) B.voices.splice(idx, 1);
      };

      return B.playhead - now;
    } catch (err) {
      fail('speak', err);
      return 0;
    }
  };

  /** Seconds of queued speech still to be heard. */
  B.remaining = function () {
    if (!B.ctx) return 0;
    var left = B.playhead - B.ctx.currentTime;
    return left > 0 ? left : 0;
  };

  /** Cuts the current utterance short, for a stop or an interruption. */
  B.stopSpeaking = function () {
    for (var i = B.voices.length - 1; i >= 0; i--) {
      try { B.voices[i].stop(); } catch (e) {}
    }
    B.voices = [];
    if (B.ctx) B.playhead = B.ctx.currentTime;
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  };

  /**
   * The Web Speech path. Resolves when the utterance finishes.
   *
   * SpeechSynthesis plays to the operating system's output device and exposes
   * no samples, so this only reaches the meeting when the host routes that
   * device into the browser's microphone with a virtual audio cable.
   */
  B.speakWebSpeech = function (text, lang, rate) {
    return new Promise(function (resolve) {
      try {
        if (!window.speechSynthesis) return resolve({ ok: false, reason: 'speechSynthesis unavailable' });

        var utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang || 'en-US';
        utterance.rate = rate || 1;
        utterance.pitch = 1;

        var settled = false;
        var done = function (ok, reason) {
          if (settled) return;
          settled = true;
          resolve({ ok: ok, reason: reason || null });
        };

        utterance.onend = function () { done(true); };
        utterance.onerror = function (e) { done(false, (e && e.error) || 'speech error'); };

        // Chrome silently drops long utterances after about fifteen seconds and
        // fires no event at all, which would hang the interview.
        var guardMs = Math.max(10000, text.length * 120);
        setTimeout(function () { done(true, 'guard timeout'); }, guardMs);

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        resolve({ ok: false, reason: (err && err.message) || 'unknown' });
      }
    });
  };

  /** Diagnostics, read by the Node side to confirm the bridge came up. */
  B.status = function () {
    return {
      contextState: B.ctx ? B.ctx.state : 'none',
      sampleRate: B.ctx ? B.ctx.sampleRate : 0,
      micInjected: B.micInjected,
      micTracks: B.micTracks.length,
      remoteTracks: B.remoteTracks,
      capturing: !!B.processor,
      queuedSeconds: B.remaining(),
      fallbackEnabled: B.fallbackEnabled,
      // Which tap found the audio, how many frames went out, and how loud the
      // loudest sample was. Between them these say whether the bot is deaf,
      // connected to silence, or working.
      sources: { rtc: B.stats.rtc, webaudio: B.stats.webaudio, element: B.stats.element },
      frames: B.stats.frames,
      peak: Math.round(B.stats.peak * 1000) / 1000,
      mediaElements: document.querySelectorAll('audio, video').length,
      errors: B.errors.slice(-5)
    };
  };

  report('bridge_ready');
})();`;
}
