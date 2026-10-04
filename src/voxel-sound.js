// VoxelCraft — 程序化音效合成
// 挂在 window.VoxelSound 上。WebAudio API，无外部音频文件。
(function (global) {
  'use strict';

  let ctx = null;
  let listenerPos = { x: 0, y: 0, z: 0 };

  function init() {
    if (ctx) return;
    ctx = new (global.AudioContext || global.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function isReady() {
    return ctx && ctx.state === 'running';
  }

  function setListener(x, y, z) {
    listenerPos = { x, y, z };
  }

  function play(name, opts) {
    if (!ctx) return;
    opts = opts || {};
    const volume = opts.volume !== undefined ? opts.volume : 0.5;
    const distance = opts.distance || 0;
    const attenuation = Math.max(0, 1 - distance / 24);

    const gain = ctx.createGain();
    gain.gain.value = volume * attenuation;
    gain.connect(ctx.destination);

    const t0 = ctx.currentTime;

    // 根据名字合成声音
    if (name.startsWith('step.')) {
      const type = name.slice(5);
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buf;

      if (type === 'stone') {
        filter.type = 'bandpass';
        filter.frequency.value = 1600;
        filter.Q.value = 3;
      } else if (type === 'wood') {
        filter.type = 'bandpass';
        filter.frequency.value = 900;
      } else if (type === 'sand') {
        filter.type = 'highpass';
        filter.frequency.value = 3000;
      } else {
        filter.type = 'lowpass';
        filter.frequency.value = 700;
      }

      noise.connect(filter);
      filter.connect(gain);
      noise.start(t0);
      noise.stop(t0 + 0.08);
    } else if (name.startsWith('break.')) {
      const type = name.slice(6);
      if (type === 'glass') {
        for (let i = 0; i < 4; i++) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = 2000 + Math.random() * 3000;
          g.gain.setValueAtTime(0.2, t0 + i * 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.02 + 0.05);
          o.connect(g);
          g.connect(gain);
          o.start(t0 + i * 0.02);
          o.stop(t0 + i * 0.02 + 0.05);
        }
      } else {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(type === 'stone' ? 110 : 180, t0);
        o.frequency.exponentialRampToValueAtTime(50, t0 + 0.25);
        g.gain.setValueAtTime(0.4, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
        o.connect(g);
        g.connect(gain);
        o.start(t0);
        o.stop(t0 + 0.25);
      }
    } else if (name.startsWith('place.')) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 440;
      g.gain.setValueAtTime(0.3, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
      o.connect(g);
      g.connect(gain);
      o.start(t0);
      o.stop(t0 + 0.1);
    } else if (name === 'hit' || name === 'hurt') {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(name === 'hit' ? 200 : 150, t0);
      o.frequency.exponentialRampToValueAtTime(80, t0 + 0.15);
      g.gain.setValueAtTime(0.5, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      o.connect(g);
      g.connect(gain);
      o.start(t0);
      o.stop(t0 + 0.15);
    } else if (name === 'splash') {
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.1, t0);
      g.gain.linearRampToValueAtTime(0.5, t0 + 0.1);
      g.gain.linearRampToValueAtTime(0.001, t0 + 0.3);
      noise.connect(filter);
      filter.connect(g);
      g.connect(gain);
      noise.start(t0);
      noise.stop(t0 + 0.3);
    } else if (name === 'pop') {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(800, t0);
      o.frequency.exponentialRampToValueAtTime(200, t0 + 0.06);
      g.gain.setValueAtTime(0.4, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.06);
      o.connect(g);
      g.connect(gain);
      o.start(t0);
      o.stop(t0 + 0.06);
    }
  }

  global.VoxelSound = { init, play, setListener, isReady };
})(window);
