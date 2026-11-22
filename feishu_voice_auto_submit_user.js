// ==UserScript==
// @name         语录 - 录音静音10秒自动完成并提交下一条
// @namespace    https://bytedance.feishu.link/
// @version      1.0.0
// @description  监听麦克风音量：检测到人声说话后，持续静音满10秒自动点击红色“完成”按钮；等待响应且“提交并进行下一条”按钮变蓝可用后自动移过去并点击。包含可视化音量与倒计时悬浮面板。
// @author       Li
// @match        https://bytedance.feishu.link/app/*
// @match        https://*.feishu.link/app/*
// @match        https://*.feishu.cn/app/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ==================== 默认配置（可在悬浮面板中实时调节并自动保存） ====================
    const STORAGE_KEY = 'feishu_voice_auto_submit_cfg_v1';
    const defaultConfig = {
        enabled: true,             // 是否开启自动流程
        volumeThreshold: 0.025,    // 声音判定阈值 (RMS: 0.005 ~ 0.15)
        minSpeechMs: 250,          // 判定为“已开始说话”所需的最短累计发声时长 (ms)
        silenceTargetMs: 10000,    // 说话后要求的连续空白静音时长 (10000ms = 10秒)
        submitDelayMs: 300         // 按钮变蓝解锁后的点击缓冲延迟 (ms)
    };

    let config = Object.assign({}, defaultConfig, loadConfig());

    function loadConfig() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch (e) {}
    }

    // ==================== 运行状态机 ====================
    // 状态枚举:
    // IDLE               : 未处于录音状态
    // WAITING_SPEECH     : 录制中，等待说话人开口
    // COUNTING_SILENCE   : 已检测到人声，正在检测10秒静音空白
    // CLICKED_FINISH     : 已点击红色“完成”，等待上传/响应及“提交并进行下一条”变蓝
    // SUBMITTING         : 已点击“提交并进行下一条”，等待切换或下一次录制
    let state = 'IDLE';
    let speechAccumulatedMs = 0;
    let silenceStartTimestamp = null;
    let lastTickTimestamp = performance.now();
    let currentRms = 0;
    let finishClickedAt = 0;

    // 音频分析相关
    let audioCtx = null;
    let analyser = null;
    let mediaStreamSource = null;
    let activeStream = null;
    let dataArray = null;
    let manualMicRequesting = false;

    // ==================== 拦截 getUserMedia 共享网页麦克风流 ====================
    function setupMediaHook() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        navigator.mediaDevices.getUserMedia = async function (constraints) {
            const stream = await origGetUserMedia(constraints);
            if (constraints && constraints.audio) {
                attachMediaStream(stream, '页面录音流');
            }
            return stream;
        };

        if (pageWindow.navigator && pageWindow.navigator.mediaDevices && pageWindow.navigator.mediaDevices !== navigator.mediaDevices) {
            const origPageGUM = pageWindow.navigator.mediaDevices.getUserMedia.bind(pageWindow.navigator.mediaDevices);
            pageWindow.navigator.mediaDevices.getUserMedia = async function (constraints) {
                const stream = await origPageGUM(constraints);
                if (constraints && constraints.audio) {
                    attachMediaStream(stream, '页面录音流');
                }
                return stream;
            };
        }
    }

    setupMediaHook();

    function attachMediaStream(stream, sourceLabel) {
        try {
            if (!stream || !stream.getAudioTracks().length) return;
            activeStream = stream;

            const AudioContextClass = pageWindow.AudioContext || pageWindow.webkitAudioContext;
            if (!audioCtx || audioCtx.state === 'closed') {
                audioCtx = new AudioContextClass();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }

            if (mediaStreamSource) {
                try { mediaStreamSource.disconnect(); } catch (e) {}
            }

            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.2;

            mediaStreamSource = audioCtx.createMediaStreamSource(stream);
            mediaStreamSource.connect(analyser);
            dataArray = new Float32Array(analyser.fftSize);

            updateHudMicStatus(`已连接 (${sourceLabel})`, '#10b981');
        } catch (err) {
            console.error('[语录自动脚本] 绑定音频流失败:', err);
            updateHudMicStatus('音频流绑定失败', '#ef4444');
        }
    }

    async function ensureMicStream() {
        // 检查当前流是否仍然存活
        if (activeStream) {
            const tracks = activeStream.getAudioTracks();
            if (tracks.length > 0 && tracks[0].readyState === 'live') {
                if (audioCtx && audioCtx.state === 'suspended') {
                    audioCtx.resume().catch(() => {});
                }
                return true;
            }
        }
        if (manualMicRequesting) return false;
        manualMicRequesting = true;
        try {
            updateHudMicStatus('正在请求麦克风监听...', '#f59e0b');
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            attachMediaStream(stream, '独立监听流');
            manualMicRequesting = false;
            return true;
        } catch (err) {
            console.warn('[语录自动脚本] 无法主动获取麦克风流:', err);
            updateHudMicStatus('等待麦克风权限', '#ef4444');
            manualMicRequesting = false;
            return false;
        }
    }

    function readCurrentVolumeRms() {
        if (!analyser || !dataArray) return 0;
        analyser.getFloatTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const sample = dataArray[i];
            sumSquares += sample * sample;
        }
        return Math.sqrt(sumSquares / dataArray.length);
    }

    // ==================== 页面元素查找与状态判定 ====================
    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity || '1') > 0.05
        );
    }

    // 查找红色的“完成”按钮
    function findRedFinishButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
            if (!isElementVisible(btn)) continue;
            const text = (btn.textContent || '').trim();
            if (text === '完成') {
                // 校验具有红色特征类名 bg-rose 或内部含停止方块图标 lucide-square
                const cls = btn.className || '';
                const hasSquareIcon = !!btn.querySelector('svg.lucide-square, rect');
                if (cls.includes('bg-rose') || hasSquareIcon) {
                    return btn;
                }
            }
        }
        return null;
    }

    // 查找“提交并进行下一条”按钮
    function findSubmitNextButton() {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
            if (!isElementVisible(btn)) continue;
            const text = (btn.textContent || '').trim();
            if (text.includes('提交并进行下一条')) {
                return btn;
            }
        }
        return null;
    }

    // 判断“提交并进行下一条”按钮是否已经变蓝且可点击
    function isSubmitButtonBlueAndReady(btn) {
        if (!btn || !isElementVisible(btn)) return false;
        if (btn.disabled || btn.hasAttribute('disabled')) return false;
        if (btn.getAttribute('aria-busy') === 'true') return false;

        // 检查是否还有“必填项未完成”提示
        const alertBoxes = Array.from(document.querySelectorAll('.text-destructive'));
        const stillMissingAudio = alertBoxes.some(el => {
            if (!isElementVisible(el)) return false;
            const txt = el.textContent || '';
            return txt.includes('必填项未完成') && txt.includes('录音');
        });
        if (stillMissingAudio) return false;

        // 校验计算样式背景色：未禁用时应用 [data-slot=button][data-variant=default]:not(:disabled) 呈现蓝色
        const bgColor = window.getComputedStyle(btn).backgroundColor || '';
        // 排除透明或浅灰白色禁用态 (如 rgb(250, 250, 252) 等高亮浅色)
        const rgbMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1], 10);
            const g = parseInt(rgbMatch[2], 10);
            const b = parseInt(rgbMatch[3], 10);
            // 蓝色按钮特征：蓝色通道明显高于红色通道，且不是接近纯白的浅灰底色
            if (r > 210 && g > 210 && b > 210) {
                return false;
            }
            if (b <= r) {
                return false;
            }
        }
        return true;
    }

    // 模拟真实鼠标移动与点击
    function moveAndClickElement(el) {
        if (!el) return;
        // 1. 平滑滚动到可视区域中央
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 2. 在按钮上显示视觉高亮框提示正在操作
        const prevOutline = el.style.outline;
        const prevOutlineOffset = el.style.outlineOffset;
        el.style.outline = '3px solid #3b82f6';
        el.style.outlineOffset = '3px';
        setTimeout(() => {
            el.style.outline = prevOutline;
            el.style.outlineOffset = prevOutlineOffset;
        }, 1200);

        // 3. 触发鼠标移入、移动、按下、抬起和点击事件序列
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const eventInit = {
            bubbles: true,
            cancelable: true,
            view: pageWindow,
            clientX,
            clientY
        };

        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mouseenter', eventInit));
        el.dispatchEvent(new MouseEvent('mousemove', eventInit));
        el.dispatchEvent(new MouseEvent('mousedown', eventInit));
        el.focus();
        el.dispatchEvent(new MouseEvent('mouseup', eventInit));
        el.click();
    }

    // ==================== 核心循环逻辑 ====================
    function resetRecordingState() {
        speechAccumulatedMs = 0;
        silenceStartTimestamp = null;
    }

    function tick() {
        const now = performance.now();
        const dt = Math.min(200, Math.max(0, now - lastTickTimestamp));
        lastTickTimestamp = now;

        const finishBtn = findRedFinishButton();
        const isRecording = !!(finishBtn && !finishBtn.disabled && finishBtn.getAttribute('aria-busy') !== 'true');

        if (!config.enabled) {
            state = 'IDLE';
            resetRecordingState();
            updateHudUI(0, '已暂停自动脚本', 0);
            return;
        }

        // 如果检测到红色“完成”按钮出现（正在录制中）
        if (isRecording) {
            ensureMicStream();
            currentRms = readCurrentVolumeRms();

            if (state === 'IDLE' || state === 'CLICKED_FINISH' || state === 'SUBMITTING') {
                // 新一轮录音开始
                state = 'WAITING_SPEECH';
                resetRecordingState();
            }

            if (state === 'WAITING_SPEECH') {
                if (currentRms >= config.volumeThreshold) {
                    speechAccumulatedMs += dt;
                    if (speechAccumulatedMs >= config.minSpeechMs) {
                        state = 'COUNTING_SILENCE';
                        silenceStartTimestamp = null;
                    }
                } else {
                    speechAccumulatedMs = Math.max(0, speechAccumulatedMs - dt * 0.5);
                }
                updateHudUI(
                    currentRms,
                    `等待说话发声... (${Math.min(100, Math.round((speechAccumulatedMs / config.minSpeechMs) * 100))}%)`,
                    0
                );
            } else if (state === 'COUNTING_SILENCE') {
                if (currentRms >= config.volumeThreshold) {
                    // 说话人继续说话或发出声音，重置10秒静音计时
                    silenceStartTimestamp = null;
                    updateHudUI(currentRms, '检测到声音，静音计时已重置', 0);
                } else {
                    // 处于静音状态
                    if (silenceStartTimestamp === null) {
                        silenceStartTimestamp = now;
                    }
                    const elapsedSilenceMs = now - silenceStartTimestamp;
                    const remainingSec = Math.max(0, (config.silenceTargetMs - elapsedSilenceMs) / 1000);
                    const progress = Math.min(1, elapsedSilenceMs / config.silenceTargetMs);

                    updateHudUI(
                        currentRms,
                        `静音倒计时: ${remainingSec.toFixed(1)}s / ${(config.silenceTargetMs / 1000).toFixed(0)}s`,
                        progress
                    );

                    if (elapsedSilenceMs >= config.silenceTargetMs) {
                        // 满足声音后10秒空白，立即点击红色“完成”按钮
                        state = 'CLICKED_FINISH';
                        finishClickedAt = now;
                        resetRecordingState();
                        updateHudUI(currentRms, '已满10秒静音，正在点击【完成】...', 1);
                        moveAndClickElement(finishBtn);

                        // 提前滚动到“提交并进行下一条”按钮位置等待变蓝
                        setTimeout(() => {
                            const submitBtn = findSubmitNextButton();
                            if (submitBtn) {
                                submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 350);
                    }
                }
            }
            return;
        }

        // 如果当前不在录制中，检查是否处于“已点击完成，等待提交按钮变蓝”阶段
        if (state === 'CLICKED_FINISH') {
            const submitBtn = findSubmitNextButton();
            if (submitBtn && isSubmitButtonBlueAndReady(submitBtn)) {
                state = 'SUBMITTING';
                updateHudUI(0, '【提交并进行下一条】已变蓝，正在点击...', 1);
                setTimeout(() => {
                    const latestSubmitBtn = findSubmitNextButton();
                    if (latestSubmitBtn && isSubmitButtonBlueAndReady(latestSubmitBtn)) {
                        moveAndClickElement(latestSubmitBtn);
                        updateHudUI(0, '已提交！等待下一条开始录音...', 0);
                    } else {
                        state = 'CLICKED_FINISH';
                    }
                }, config.submitDelayMs);
            } else {
                // 超时保护（例如超过30秒仍未响应则回到IDLE允许重来）
                if (now - finishClickedAt > 30000) {
                    state = 'IDLE';
                    updateHudUI(0, '等待提交响应超时，已重置', 0);
                } else {
                    updateHudUI(0, '等待录音上传响应及提交按钮变蓝...', 0.5);
                }
            }
            return;
        }

        if (state === 'SUBMITTING') {
            updateHudUI(0, '已提交，等待开始下一题录音...', 0);
            return;
        }

        // 默认空闲状态
        currentRms = activeStream ? readCurrentVolumeRms() : 0;
        updateHudUI(currentRms, '待机中（开始录音后自动接管）', 0);
    }

    // ==================== 悬浮控制面板 (HUD) ====================
    let hudRefs = {};

    function createHud() {
        if (document.getElementById('feishu-voice-auto-hud')) return;

        const container = document.createElement('div');
        container.id = 'feishu-voice-auto-hud';
        container.style.cssText = [
            'position: fixed',
            'bottom: 20px',
            'right: 20px',
            'z-index: 999999',
            'width: 280px',
            'background: rgba(15, 23, 42, 0.92)',
            'backdrop-filter: blur(10px)',
            'color: #f8fafc',
            'border-radius: 14px',
            'padding: 12px 14px',
            'box-shadow: 0 10px 25px rgba(0,0,0,0.28)',
            'font-family: system-ui, -apple-system, sans-serif',
            'font-size: 12px',
            'line-height: 1.4',
            'border: 1px solid rgba(255,255,255,0.12)',
            'user-select: none'
        ].join(';');

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <strong style="font-size:13px;color:#fff;display:flex;align-items:center;gap:6px;">
                    <span id="fv-dot" style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;"></span>
                    录音自动完成 & 提交
                </strong>
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;">
                    <input type="checkbox" id="fv-toggle" ${config.enabled ? 'checked' : ''} style="cursor:pointer;">
                    <span>启用</span>
                </label>
            </div>
            <div id="fv-mic-status" style="font-size:11px;color:#94a3b8;margin-bottom:6px;">麦克风: 待连接</div>
            <div id="fv-state-text" style="font-size:12px;font-weight:600;color:#38bdf8;margin-bottom:8px;">待机中...</div>
            <div style="margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1;margin-bottom:3px;">
                    <span>实时音量 / 阈值线</span>
                    <span id="fv-rms-val">0.000</span>
                </div>
                <div style="position:relative;height:8px;background:#334155;border-radius:4px;overflow:hidden;">
                    <div id="fv-vol-bar" style="height:100%;width:0%;background:#22c55e;transition:width 0.06s linear;"></div>
                    <div id="fv-thresh-marker" style="position:absolute;top:0;bottom:0;width:2px;background:#f43f5e;"></div>
                </div>
            </div>
            <div style="margin-bottom:10px;">
                <div style="height:6px;background:#334155;border-radius:3px;overflow:hidden;">
                    <div id="fv-timer-bar" style="height:100%;width:0%;background:#3b82f6;transition:width 0.1s linear;"></div>
                </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <span style="color:#cbd5e1;">静音阈值: <b id="fv-th-label">${config.volumeThreshold.toFixed(3)}</b></span>
                    <input type="range" id="fv-th-slider" min="0.005" max="0.120" step="0.002" value="${config.volumeThreshold}" style="width:120px;cursor:pointer;">
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                    <span style="color:#cbd5e1;">静音秒数: <b id="fv-sec-label">${(config.silenceTargetMs / 1000).toFixed(1)}s</b></span>
                    <input type="range" id="fv-sec-slider" min="3" max="15" step="0.5" value="${config.silenceTargetMs / 1000}" style="width:120px;cursor:pointer;">
                </div>
            </div>
        `;

        document.body.appendChild(container);

        hudRefs = {
            dot: container.querySelector('#fv-dot'),
            toggle: container.querySelector('#fv-toggle'),
            micStatus: container.querySelector('#fv-mic-status'),
            stateText: container.querySelector('#fv-state-text'),
            rmsVal: container.querySelector('#fv-rms-val'),
            volBar: container.querySelector('#fv-vol-bar'),
            threshMarker: container.querySelector('#fv-thresh-marker'),
            timerBar: container.querySelector('#fv-timer-bar'),
            thLabel: container.querySelector('#fv-th-label'),
            thSlider: container.querySelector('#fv-th-slider'),
            secLabel: container.querySelector('#fv-sec-label'),
            secSlider: container.querySelector('#fv-sec-slider')
        };

        updateThresholdMarker();

        hudRefs.toggle.addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            saveConfig();
            hudRefs.dot.style.background = config.enabled ? '#10b981' : '#64748b';
        });

        hudRefs.thSlider.addEventListener('input', (e) => {
            config.volumeThreshold = parseFloat(e.target.value);
            hudRefs.thLabel.textContent = config.volumeThreshold.toFixed(3);
            updateThresholdMarker();
            saveConfig();
        });

        hudRefs.secSlider.addEventListener('input', (e) => {
            const sec = parseFloat(e.target.value);
            config.silenceTargetMs = Math.round(sec * 1000);
            hudRefs.secLabel.textContent = `${sec.toFixed(1)}s`;
            saveConfig();
        });
    }

    function updateThresholdMarker() {
        if (!hudRefs.threshMarker) return;
        const pct = Math.min(100, (config.volumeThreshold / 0.15) * 100);
        hudRefs.threshMarker.style.left = `${pct}%`;
    }

    function updateHudMicStatus(text, color) {
        if (!hudRefs.micStatus) return;
        hudRefs.micStatus.textContent = `麦克风: ${text}`;
        hudRefs.micStatus.style.color = color || '#94a3b8';
    }

    function updateHudUI(rms, statusText, timerProgress) {
        if (!hudRefs.stateText) return;
        hudRefs.stateText.textContent = statusText;
        hudRefs.rmsVal.textContent = rms.toFixed(3);

        const volPct = Math.min(100, (rms / 0.15) * 100);
        hudRefs.volBar.style.width = `${volPct}%`;
        hudRefs.volBar.style.background = rms >= config.volumeThreshold ? '#f43f5e' : '#22c55e';

        hudRefs.timerBar.style.width = `${Math.min(100, Math.max(0, timerProgress * 100))}%`;
    }

    function initWhenDomReady() {
        if (document.body) {
            createHud();
        } else {
            window.addEventListener('DOMContentLoaded', createHud, { once: true });
        }
        setInterval(() => {
            if (document.body && !document.getElementById('feishu-voice-auto-hud')) {
                createHud();
            }
            tick();
        }, 80);
    }

    initWhenDomReady();
})();
