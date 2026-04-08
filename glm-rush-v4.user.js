// ==UserScript==
// @name         智谱 GLM Coding 抢购助手 v4.0
// @namespace    http://tampermonkey.net/
// @version      4.4
// @description  并发重试 + 自适应间隔 + 反检测 + check校验 + 弹窗恢复 + 定时触发 + 配置持久化
// @author       Assistant
// @match        *://www.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════
    //  配置 (localStorage 持久化)
    // ═══════════════════════════════════════════
    const DEFAULT_CFG = {
        concurrency: 5,       // 并发路数 (普通模式)
        turboConcurrency: 10, // 极速模式并发路数
        turboSec: 5,          // 极速模式持续秒数
        maxRetry: 2000,       // 最大重试次数
        burstCount: 20,       // 前N次零延迟爆发
        fastDelay: 30,        // 爆发后的快速间隔
        slowDelay: 100,       // 后期随机间隔中值
        jitter: 0.3,          // 间隔随机抖动 ±30%
        recoveryMax: 3,       // 弹窗恢复最大次数
        logMax: 100,          // 日志条数上限
        PREVIEW: '/api/biz/pay/preview',
        CHECK: '/api/biz/pay/check',
    };

    function loadCfg() {
        try {
            const saved = JSON.parse(localStorage.getItem('glm_rush_cfg'));
            return { ...DEFAULT_CFG, ...saved };
        } catch { return { ...DEFAULT_CFG }; }
    }
    function saveCfg(cfg) {
        const { PREVIEW, CHECK, ...save } = cfg;
        localStorage.setItem('glm_rush_cfg', JSON.stringify(save));
    }

    const CFG = loadCfg();

    // ═══════════════════════════════════════════
    //  状态 (不可变更新)
    // ═══════════════════════════════════════════
    let state = {
        status: 'idle',      // idle | retrying | success | failed
        count: 0,
        bizId: null,
        captured: null,      // 捕获的请求参数
        cache: null,         // 成功响应缓存
        lastSuccess: null,
        proactive: false,
        timerId: null,
        logs: [],
        stats: { total: 0, success: 0, errors: 0, avgMs: 0, startTime: 0 },
    };

    function setState(patch) {
        state = { ...state, ...patch };
        refreshUI();
    }

    // 恢复上次捕获的请求
    try {
        const saved = sessionStorage.getItem('glm_rush_captured');
        if (saved) state.captured = JSON.parse(saved);
    } catch {}

    let stopRequested = false;
    let recovering = false;
    let recoveryAttempts = 0;
    let _shadowRef = null;

    // ═══════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const rand = (min, max) => min + Math.random() * (max - min);
    const jitteredDelay = base => Math.round(base * (1 + (Math.random() * 2 - 1) * CFG.jitter));

    function getDelay(attempt) {
        if (attempt <= CFG.burstCount) return 0;
        if (attempt <= 50) return jitteredDelay(CFG.fastDelay);
        return jitteredDelay(CFG.slowDelay);
    }

    function log(msg, level = 'info') {
        const entry = { ts: ts(), msg, level };
        const logs = [...state.logs, entry];
        if (logs.length > CFG.logMax) logs.splice(0, logs.length - CFG.logMax);
        state = { ...state, logs };
        console.log(`[GLM] ${msg}`);
        appendLogDOM(entry);
    }

    function extractHeaders(h) {
        const o = {};
        if (!h) return o;
        if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
        else Object.entries(h).forEach(([k, v]) => (o[k] = v));
        return o;
    }

    // ═══════════════════════════════════════════
    //  JSON.parse 定向拦截 (仅修改特定数据结构)
    // ═══════════════════════════════════════════
    const _parse = JSON.parse;

    function patchSoldOut(obj, visited = new WeakSet()) {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.isSoldOut === true) obj.isSoldOut = false;
        if (obj.soldOut === true) obj.soldOut = false;
        if (obj.disabled === true && (obj.price !== undefined || obj.productId || obj.title)) obj.disabled = false;
        if (obj.stock === 0) obj.stock = 999;
        for (const k of Object.keys(obj)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (obj[k] && typeof obj[k] === 'object') patchSoldOut(obj[k], visited);
        }
    }

    // 全局 patch: 页面加载时也需要解除售罄状态，否则按钮不可点击
    JSON.parse = function (text, reviver) {
        const result = _parse(text, reviver);
        try { patchSoldOut(result); } catch {}
        return result;
    };
    Object.defineProperty(JSON.parse, 'toString', { value: () => 'function parse() { [native code] }' });

    // ═══════════════════════════════════════════
    //  核心: 并发重试引擎
    // ═══════════════════════════════════════════
    const _fetch = window.fetch;
    let _retryLock = null;

    async function singleAttempt(url, opts, attemptNum) {
        try {
            // 请求指纹随机化 — 每次请求看起来不一样，降低被识别为脚本的概率
            const randHeaders = { ...opts.headers };
            randHeaders['X-Request-Id'] = Math.random().toString(36).slice(2, 15);
            randHeaders['X-Timestamp'] = String(Date.now());
            // 随机 Accept-Language 权重，让每次请求指纹不同
            const q = (0.5 + Math.random() * 0.5).toFixed(1);
            randHeaders['Accept-Language'] = `zh-CN,zh;q=${q},en;q=${(q * 0.7).toFixed(1)}`;

            const resp = await _fetch(url, { ...opts, headers: randHeaders, credentials: 'include' });

            // HTTP 状态码检测
            if (resp.status === 401 || resp.status === 403) {
                return { ok: false, reason: `HTTP ${resp.status} 会话过期`, attempt: attemptNum };
            }
            if (resp.status === 429) {
                return { ok: false, reason: '429 限流', attempt: attemptNum };
            }

            const text = await resp.text();
            let data;
            try { data = _parse(text); } catch { data = null; }

            if (data && data.code === 200 && data.data && data.data.bizId) {
                const bizId = data.data.bizId;

                // check 校验
                try {
                    const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                    const checkResp = await _fetch(checkUrl, { credentials: 'include' });
                    const checkText = await checkResp.text();
                    let checkData;
                    try { checkData = _parse(checkText); } catch { checkData = null; }

                    if (checkData && checkData.data === 'EXPIRE') {
                        return { ok: false, reason: 'EXPIRE', attempt: attemptNum };
                    }

                    // 通过!
                    return { ok: true, text, data, bizId, status: resp.status, attempt: attemptNum };
                } catch (e) {
                    return { ok: false, reason: `check异常: ${e.message}`, attempt: attemptNum };
                }
            }

            const reason = !data ? '非JSON'
                : data.code === 555 ? '系统繁忙'
                : (data.data && data.data.bizId === null) ? '售罄'
                : `code=${data.code}`;
            return { ok: false, reason, attempt: attemptNum };
        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, reason: '已取消', attempt: attemptNum };
            return { ok: false, reason: `网络: ${e.message}`, attempt: attemptNum };
        }
    }

    async function retry(url, rawOpts) {
        if (_retryLock) {
            log('合并到当前重试...');
            return _retryLock;
        }

        stopRequested = false;
        const { signal, ...opts } = rawOpts || {};

        _retryLock = (async () => {
            setState({ status: 'retrying', count: 0, stats: { ...state.stats, startTime: performance.now() } });

            let totalAttempt = 0;
            let consecutiveErrors = 0;
            let throttleCount = 0;
            let consecutiveSoldOut = 0;

            while (totalAttempt < CFG.maxRetry && !stopRequested) {
                // 极速模式: 前N秒用更高并发
                const elapsedMs = performance.now() - state.stats.startTime;
                const isTurbo = elapsedMs < CFG.turboSec * 1000;
                const curConcurrency = isTurbo ? CFG.turboConcurrency : CFG.concurrency;
                const batchSize = Math.min(curConcurrency, CFG.maxRetry - totalAttempt);
                const controllers = [];
                const promises = [];

                for (let j = 0; j < batchSize; j++) {
                    totalAttempt++;
                    const ac = new AbortController();
                    controllers.push(ac);
                    promises.push(
                        singleAttempt(url, { ...opts, signal: ac.signal }, totalAttempt)
                    );
                }

                setState({ count: totalAttempt });

                // 任一成功即取消其余
                const winner = await new Promise(resolve => {
                    let settled = false;
                    let doneCount = 0;
                    promises.forEach((p, idx) => {
                        p.then(r => {
                            if (r.ok && !settled) {
                                settled = true;
                                controllers.forEach((ac, i) => { if (i !== idx) try { ac.abort(); } catch {} });
                                resolve(r);
                            }
                            if (++doneCount === promises.length && !settled) resolve(null);
                        });
                    });
                });

                // 收集失败原因 (用于日志)
                const results = await Promise.all(promises.map(p => p.catch(() => ({ ok: false, reason: '已取消' }))));

                if (winner) {
                    setState({
                        status: 'success',
                        bizId: winner.bizId,
                        lastSuccess: { text: winner.text, data: winner.data },
                        stats: { ...state.stats, total: totalAttempt, success: state.stats.success + 1 },
                    });
                    log(`成功! bizId=${winner.bizId} (第${winner.attempt}次)`);
                    recoveryAttempts = 0;
                    setTimeout(autoRecover, 500);
                    return { ok: true, text: winner.text, data: winner.data, status: winner.status };
                }

                // 统计错误
                const failedResults = results.filter(r => !r.ok);
                const reasons = failedResults.map(r => r.reason || '未知');
                setState({ stats: { ...state.stats, errors: state.stats.errors + failedResults.length } });

                const networkErrors = reasons.filter(r => r.startsWith('网络')).length;
                consecutiveErrors = networkErrors === batchSize ? consecutiveErrors + 1 : 0;

                // 连续网络错误 → 暂停
                if (consecutiveErrors >= 3) {
                    log('网络异常, 暂停3秒...');
                    await sleep(3000);
                    consecutiveErrors = 0;
                }

                // 会话过期检测
                if (reasons.some(r => r.includes('会话过期'))) {
                    log('会话已过期, 请重新登录!', 'error');
                    setState({ status: 'failed' });
                    return { ok: false };
                }

                // 限流检测 (独立计数)
                if (reasons.some(r => r.includes('429') || r.includes('限流'))) {
                    throttleCount++;
                    const backoff = Math.min(2000 * (2 ** Math.min(throttleCount, 4)), 16000);
                    log(`限流, 退避${backoff}ms...`, 'warn');
                    await sleep(backoff);
                } else {
                    throttleCount = 0;
                }

                // EXPIRE → 立即重试不等待
                if (reasons.every(r => r === 'EXPIRE')) continue;

                // 前20秒全速冲，之后才考虑降速
                const elapsedSec = (performance.now() - state.stats.startTime) / 1000;

                if (elapsedSec > 20) {
                    // 超过20秒 — 检测是否该降速
                    const soldOutCount = reasons.filter(r => r === '售罄').length;
                    if (soldOutCount === batchSize) {
                        consecutiveSoldOut++;
                    } else {
                        consecutiveSoldOut = 0;
                    }
                    // 连续10轮全售罄 → 可能已经抢完了
                    if (consecutiveSoldOut >= 10) {
                        if (consecutiveSoldOut === 10) log('连续售罄, 可能已抢完, 降速 (2s)...');
                        await sleep(2000);
                        continue;
                    }
                }

                // 日志 (前5次 + 每20次)
                if (totalAttempt <= 5 * CFG.concurrency || totalAttempt % (20 * CFG.concurrency) === 0) {
                    const sec = elapsedSec.toFixed(0);
                    log(`#${totalAttempt} ${reasons[0]} (${sec}s)`);
                }

                // 自适应延迟
                const d = getDelay(totalAttempt / CFG.concurrency);
                if (d > 0) await sleep(d);
            }

            if (!stopRequested) {
                setState({ status: 'failed' });
                log(`达到上限 ${CFG.maxRetry} 次`);
            } else {
                setState({ status: 'idle' });
            }
            return { ok: false };
        })();

        try { return await _retryLock; }
        finally { _retryLock = null; }
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截
    // ═══════════════════════════════════════════
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;

        if (url && url.includes(CFG.PREVIEW)) {
            const captured = {
                url,
                method: init?.method || 'POST',
                body: init?.body,
                headers: extractHeaders(init?.headers),
            };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}
            log('捕获 preview (Fetch)');

            // 已经成功过 → 直接返回缓存，不再重试
            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应');
                return new Response(state.lastSuccess.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (state.cache) {
                log('返回缓存响应');
                const c = state.cache;
                setState({ cache: null });
                recoveryAttempts = 0;
                return new Response(c.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            const result = await retry(url, {
                method: init?.method || 'POST',
                body: init?.body,
                headers: extractHeaders(init?.headers),
            });

            if (result.ok) {
                return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
            }
            return _fetch.apply(this, [input, init]);
        }

        if (url && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            log('拦截 check(bizId=null)');
            return new Response('{"code":-1,"msg":"等待有效bizId"}', {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return _fetch.apply(this, [input, init]);
    };
    // 伪装
    window.fetch.toString = () => 'function fetch() { [native code] }';

    // ═══════════════════════════════════════════
    //  XHR 拦截
    // ═══════════════════════════════════════════
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        (this._h || (this._h = {}))[k] = v;
        return _xhrSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
        this._m = method; this._u = url;
        return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._u;

        if (typeof url === 'string' && url.includes(CFG.PREVIEW)) {
            const self = this;
            const captured = { url, method: this._m, body, headers: this._h || {} };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}
            log('捕获 preview (XHR)');

            // 已经成功过 → 直接返回缓存
            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应 (XHR)');
                fakeXHR(self, state.lastSuccess.text);
                return;
            }

            if (state.cache) {
                log('返回缓存响应 (XHR)');
                const c = state.cache; setState({ cache: null });
                recoveryAttempts = 0;
                fakeXHR(self, c.text);
                return;
            }

            retry(url, { method: this._m, body, headers: this._h || {} }).then(result => {
                fakeXHR(self, result.ok ? result.text : '{"code":-1,"msg":"重试失败"}');
            });
            return;
        }

        if (typeof url === 'string' && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            fakeXHR(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return _xhrSend.call(this, body);
    };

    function fakeXHR(xhr, text) {
        setTimeout(() => {
            const dp = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
            dp('readyState', 4); dp('status', 200); dp('statusText', 'OK');
            dp('responseText', text); dp('response', text);
            const ev = new Event('readystatechange');
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(ev);
            xhr.dispatchEvent(ev);
            const ld = new ProgressEvent('load');
            if (typeof xhr.onload === 'function') xhr.onload(ld);
            xhr.dispatchEvent(ld);
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ═══════════════════════════════════════════
    //  弹窗恢复
    // ═══════════════════════════════════════════
    function findErrorDialog() {
        const sels = [
            '.el-dialog', '.el-message-box', '.el-dialog__wrapper',
            '.ant-modal', '.ant-modal-wrap',
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[role="dialog"]',
        ];
        for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                if (!el.offsetParent && s.position !== 'fixed') continue;
                if (/购买人数过多|系统繁忙|稍后再试|请重试|繁忙|失败|出错|异常/.test(el.textContent || '')) return el;
            }
        }
        return null;
    }

    function dismissDialog(dialog) {
        // 关闭按钮
        for (const sel of ['.el-dialog__headerbtn', '.el-message-box__headerbtn', '.ant-modal-close', '[aria-label="Close"]', '[aria-label="close"]']) {
            const btn = dialog.querySelector(sel) || document.querySelector(sel);
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        }
        // 确定/取消按钮
        for (const btn of dialog.querySelectorAll('button, [role="button"]')) {
            const t = (btn.textContent || '').trim();
            if (/关闭|确定|取消|知道了|OK|Cancel|Close|确认/.test(t) && t.length < 10) { btn.click(); return true; }
        }
        // Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        // 遮罩
        for (const mask of document.querySelectorAll('.el-overlay, .v-modal, [class*="overlay"], [class*="mask"]')) {
            if (mask.offsetParent !== null || window.getComputedStyle(mask).position === 'fixed') { mask.click(); return true; }
        }
        dialog.style.display = 'none';
        return true;
    }

    async function autoRecover() {
        if (recovering || recoveryAttempts >= CFG.recoveryMax || !state.lastSuccess) return;

        recovering = true;
        recoveryAttempts++;
        try {
            // 策略1: 关闭所有弹窗/遮罩 (暴力清理)
            const dialog = findErrorDialog();
            if (dialog) {
                log('检测到错误弹窗, 清理中...');
                dismissDialog(dialog);
                await sleep(300);
            }
            // 清理所有可能残留的遮罩层
            document.querySelectorAll('.el-overlay, .v-modal, .el-overlay-dialog, [class*="overlay"], [class*="mask"]').forEach(el => {
                el.style.display = 'none';
            });
            document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper').forEach(el => {
                el.style.display = 'none';
            });
            // 移除 body 上的 overflow:hidden (弹窗锁定滚动)
            document.body.style.overflow = '';
            document.body.classList.remove('el-popup-parent--hidden');
            await sleep(200);

            // 策略2: 缓存响应 + 重新点购买按钮
            setState({ cache: state.lastSuccess });
            const btn = findBuyButton();
            if (btn) {
                btn.click();
                log('已重新点击购买按钮 (策略2)');
                await sleep(2000);
            }

            // 策略3: 检查支付弹窗是否出现, 没有则直接用 bizId 构造支付
            const payDialog = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"]');
            if (!payDialog || payDialog.offsetParent === null) {
                const bizId = state.bizId;
                if (bizId) {
                    log('支付弹窗未出现, 尝试直接调用 check 页面...');
                    // 尝试直接打开支付 — 有些网站 check 接口会返回支付链接
                    try {
                        const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                        const resp = await _fetch(checkUrl, { credentials: 'include' });
                        const data = await resp.json();
                        log('check响应: ' + JSON.stringify(data).substring(0, 200));

                        // 如果有支付URL, 直接跳转
                        if (data.data && typeof data.data === 'string' && data.data.startsWith('http')) {
                            log('获取到支付链接, 跳转中...');
                            window.open(data.data, '_blank');
                        } else if (data.data && data.data.payUrl) {
                            log('获取到payUrl, 跳转中...');
                            window.open(data.data.payUrl, '_blank');
                        } else if (data.data && data.data.qrCode) {
                            log('获取到二维码数据');
                            showQRCodeFallback(data.data.qrCode, bizId);
                        }
                    } catch (e) {
                        log('check调用失败: ' + e.message);
                    }
                }

                // 策略4: 最终兜底 — 弹窗提醒手动操作
                if (!document.querySelector('[class*="pay"], [class*="qrcode"]')) {
                    log('所有自动恢复策略已尝试, 请手动操作');
                    const bizId = state.bizId;
                    alert(`已抢到 bizId=${bizId}\n\n请尝试:\n1. 刷新页面后立即点击购买\n2. 或手动访问支付页面`);
                }
            } else {
                log('支付弹窗已出现!');
            }
        } finally { recovering = false; }
    }

    /** 兜底: 直接在页面上显示二维码 */
    function showQRCodeFallback(qrData, bizId) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;padding:30px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center';
        div.innerHTML = `
            <h3 style="margin:0 0 15px;color:#333">扫码支付</h3>
            <img src="${qrData}" style="width:200px;height:200px" onerror="this.parentElement.innerHTML+='<p>二维码加载失败</p>'">
            <p style="margin:15px 0 0;color:#666;font-size:13px">bizId: ${bizId}</p>
            <button onclick="this.parentElement.remove()" style="margin-top:10px;padding:6px 20px;border:1px solid #ddd;border-radius:4px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(div);
        log('已显示兜底支付二维码');
    }

    // MutationObserver 监控弹窗 (替代 setInterval)
    function setupDialogWatcher() {
        const observer = new MutationObserver(() => {
            if (state.lastSuccess && !recovering && recoveryAttempts < CFG.recoveryMax) {
                const d = findErrorDialog();
                if (d) autoRecover();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════
    //  主动抢购 & 定时
    // ═══════════════════════════════════════════
    function findBuyButton() {
        for (const el of document.querySelectorAll('button, a, [role="button"], div[class*="btn"], span[class*="btn"]')) {
            const t = el.textContent.trim();
            if (/购买|抢购|立即|下单|订阅/.test(t) && t.length < 20 && el.offsetParent !== null) return el;
        }
        return null;
    }

    async function startProactive() {
        if (!state.captured) {
            log('请先手动点一次购买按钮');
            alert('请先手动点一次购买/订阅按钮，让脚本捕获请求参数');
            return;
        }
        if (state.status === 'success') {
            log('已经抢到了, 不重复抢购');
            return;
        }
        setState({ proactive: true });
        log(`极速抢购启动! 前${CFG.turboSec}秒${CFG.turboConcurrency}路并发, 之后${CFG.concurrency}路`);

        const { url, method, body, headers } = state.captured;
        const result = await retry(url, { method, body, headers });
        setState({ proactive: false });

        if (result.ok) {
            setState({ cache: { text: result.text, data: result.data } });
            log('抢购成功! 触发支付...');
            // 自动通知
            try { new Notification('GLM 抢购成功!', { body: `bizId=${state.bizId}` }); } catch {}
            const errDlg = findErrorDialog();
            if (errDlg) { dismissDialog(errDlg); await sleep(300); }
            const btn = findBuyButton();
            if (btn) { btn.click(); log('已自动点击购买按钮'); }
            else { alert('已获取到商品! 请立即点击购买按钮!'); }
        }
    }

    function stopAll() {
        stopRequested = true;
        setState({ proactive: false, status: 'idle', count: 0 });
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        log('已停止');
    }

    // ═══════════════════════════════════════════
    //  北京时间同步 + 自动定时
    // ═══════════════════════════════════════════
    let serverTimeOffset = 0; // 本地时间与服务器时间的差值(ms)

    async function syncServerTime() {
        // 用服务器响应头的 Date 字段同步时间
        try {
            const t0 = Date.now();
            const resp = await _fetch(location.origin + '/api/biz/pay/check?bizId=sync', { credentials: 'include' }).catch(() => null);
            const t1 = Date.now();
            const rtt = t1 - t0;

            if (resp && resp.headers.get('date')) {
                const serverTime = new Date(resp.headers.get('date')).getTime();
                // 服务器时间 ≈ 发送时间 + RTT/2
                serverTimeOffset = serverTime - (t0 + rtt / 2);
                const localNow = new Date(Date.now() + serverTimeOffset);
                log(`时间同步: 服务器偏差 ${serverTimeOffset > 0 ? '+' : ''}${serverTimeOffset}ms (RTT=${rtt}ms)`);
                log(`北京时间: ${localNow.toLocaleTimeString('zh-CN', { hour12: false })}`);
                return;
            }
        } catch {}

        // 备用: 用 worldtimeapi
        try {
            const resp = await fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai');
            const data = await resp.json();
            const serverTime = new Date(data.datetime).getTime();
            serverTimeOffset = serverTime - Date.now();
            log(`时间同步(备用): 偏差 ${serverTimeOffset > 0 ? '+' : ''}${serverTimeOffset}ms`);
        } catch {
            log('时间同步失败, 使用本地时钟');
            serverTimeOffset = 0;
        }
    }

    function getServerNow() {
        return Date.now() + serverTimeOffset;
    }

    // 自动定时: 同步时间后自动等待到 10:00:00
    function scheduleAt(timeStr) {
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        const parts = timeStr.split(':').map(Number);
        if (parts.length < 2 || parts[0] > 23 || parts[1] > 59) { log('时间格式错误'); return; }

        const now = new Date(getServerNow());
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);
        if (target.getTime() <= getServerNow()) { log('目标时间已过'); return; }

        const ms = target.getTime() - getServerNow();
        log(`定时: ${timeStr} (${Math.ceil(ms / 1000)}秒后, 北京时间)`);

        // 提前3秒自动预热
        if (ms > 4000) {
            setTimeout(() => {
                log('定时前3秒, 自动预热...');
                preheat();
            }, Math.max(0, ms - 3000));
        }

        // 精确等待: 用 setInterval 10ms 检查, 到时间立即启动
        const tid = setInterval(() => {
            const remaining = target.getTime() - getServerNow();
            // 更新面板倒计时
            if (remaining > 0 && remaining < 60000) {
                const sec = (remaining / 1000).toFixed(1);
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = `-${sec}s`;
            }
            if (remaining <= 0) {
                clearInterval(tid);
                setState({ timerId: null });
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = '';
                log('时间到! 自动启动抢购!');
                startProactive();
            }
        }, 10);

        setState({ timerId: tid });
    }

    // 预热
    async function preheat() {
        try {
            log('TCP预热中...');
            // 连发3次预热请求，确保连接池暖好
            for (let i = 0; i < 3; i++) {
                await _fetch(location.origin + '/api/biz/pay/check?bizId=preheat_' + i, { credentials: 'include' }).catch(() => {});
                await sleep(200);
            }
            // 也预热 preview 的 DNS + TCP (用 HEAD 请求不产生副作用)
            await _fetch(location.origin + CFG.PREVIEW, {
                method: 'HEAD',
                credentials: 'include',
            }).catch(() => {});
            log('预热完成 (4次连接已建立)');
        } catch { log('预热部分失败，不影响使用'); }
    }

    // ═══════════════════════════════════════════
    //  快捷键
    // ═══════════════════════════════════════════
    document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); startProactive(); }
        if (e.key === 'x' || e.key === 'X') { e.preventDefault(); stopAll(); }
        if (e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            if (_shadowRef) {
                const bd = _shadowRef.getElementById('bd');
                if (bd) bd.style.display = bd.style.display === 'none' ? '' : 'none';
            }
        }
    });

    // ═══════════════════════════════════════════
    //  浮动面板 (Shadow DOM)
    // ═══════════════════════════════════════════
    function createPanel() {
        const host = document.createElement('div');
        host.id = 'glm-rush-host';
        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
<style>
:host{all:initial;position:fixed;top:10px;right:10px;z-index:999999;font-family:Consolas,'Courier New',monospace}
*{box-sizing:border-box;margin:0;padding:0}
.panel{width:360px;background:#1a1a2e;color:#e0e0e0;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);font-size:13px;line-height:1.5;user-select:none}
.hd{background:linear-gradient(135deg,#0f3460,#16213e);padding:9px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move}
.hd b{font-size:14px;letter-spacing:.5px}
.mn{background:none;border:none;color:#aaa;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
.mn:hover{color:#fff}
.bd{padding:12px 14px 14px}
.st{padding:8px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:10px;transition:background .3s}
.st-idle{background:#2d3436}
.st-retrying{background:#e17055;animation:pulse 1s infinite}
.st-success{background:#00b894}
.st-failed{background:#d63031}
@keyframes pulse{50%{opacity:.7}}
.cap{font-size:11px;padding:5px 8px;background:#2d3436;border-radius:6px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;flex-wrap:wrap}
.row input[type=number],.row input[type=time]{width:60px;padding:4px 6px;border:1px solid #444;border-radius:4px;background:#2d3436;color:#fff;text-align:center;font-size:12px}
.btns{display:flex;gap:8px;margin-bottom:10px}
.btns button{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#fff;transition:opacity .2s}
.btns button:hover{opacity:.85}
.b-go{background:#0984e3}
.b-stop{background:#d63031}
.b-heat{background:#fdcb6e;color:#2d3436}
.b-time{background:#6c5ce7;flex:0 0 auto!important;padding:4px 10px!important}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;font-size:11px;text-align:center}
.stats div{background:#2d3436;border-radius:4px;padding:4px}
.stats .v{font-size:16px;font-weight:700;color:#74b9ff}
.logs{max-height:180px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.7}
.logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logs .ok{color:#00b894} .logs .warn{color:#fdcb6e} .logs .err{color:#d63031} .logs .info{color:#dfe6e9}
.logs::-webkit-scrollbar{width:4px}
.logs::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
.keys{font-size:10px;color:#636e72;text-align:center;margin-top:6px}
</style>
<div class="panel">
  <div class="hd" id="drag"><b>GLM v4.4</b><button class="mn" id="min">-</button></div>
  <div class="bd" id="bd">
    <div class="st st-idle" id="st">等待中</div>
    <div class="cap" id="cap">${state.captured ? '已恢复上次捕获的请求' : '请先点一次购买按钮'}</div>
    <div class="stats">
      <div><div class="v" id="s-cnt">0</div>重试</div>
      <div><div class="v" id="s-ok">0</div>成功</div>
      <div><div class="v" id="s-err">0</div>错误</div>
    </div>
    <div class="row">
      <span>并发</span><input type="number" id="i-conc" value="${CFG.concurrency}" min="1" max="20" step="1">
      <span>极速</span><input type="number" id="i-turbo" value="${CFG.turboConcurrency}" min="1" max="20" step="1">
      <span>上限</span><input type="number" id="i-max" value="${CFG.maxRetry}" min="10" max="9999" step="50">
    </div>
    <div class="row">
      <span>定时</span><input type="time" id="i-time" step="1">
      <button class="b-time" id="b-time">设定</button>
      <span id="timer-info" style="color:#6c5ce7;font-size:11px"></span>
    </div>
    <div class="btns">
      <button class="b-go" id="b-go">▶ 主动抢购</button>
      <button class="b-stop" id="b-stop" style="display:none">■ 停止</button>
      <button class="b-heat" id="b-heat">预热</button>
    </div>
    <div class="logs" id="logs"></div>
    <div class="keys">Alt+S 抢购 | Alt+X 停止 | Alt+H 隐藏</div>
  </div>
</div>`;

        document.body.appendChild(host);

        const $ = id => shadow.getElementById(id);
        $('b-go').onclick = startProactive;
        $('b-stop').onclick = stopAll;
        $('b-heat').onclick = preheat;
        $('b-time').onclick = () => { const v = $('i-time').value; if (v) scheduleAt(v); };
        $('i-conc').onchange = function() { CFG.concurrency = Math.max(1, +this.value || 5); saveCfg(CFG); };
        $('i-turbo').onchange = function() { CFG.turboConcurrency = Math.max(1, +this.value || 10); saveCfg(CFG); };
        $('i-max').onchange = function() { CFG.maxRetry = Math.max(10, +this.value || 2000); saveCfg(CFG); };
        $('min').onclick = function() {
            const bd = $('bd');
            const hidden = bd.style.display === 'none';
            bd.style.display = hidden ? '' : 'none';
            this.textContent = hidden ? '-' : '+';
        };

        // 拖拽
        let sx, sy, sl, st;
        $('drag').onmousedown = function(e) {
            sx = e.clientX; sy = e.clientY;
            const rect = host.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            const onMove = e => { host.style.left = (sl + e.clientX - sx) + 'px'; host.style.top = (st + e.clientY - sy) + 'px'; host.style.right = 'auto'; host.style.position = 'fixed'; };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        // 闭包引用供 refreshUI 使用
        _shadowRef = shadow;

        log('v4.4 已加载 (极速并发+时间同步+全自动抢购)');
        if (state.captured) log('已恢复上次捕获的请求参数, 可直接设定时间');
        setupDialogWatcher();

        // 自动同步服务器时间
        syncServerTime();

        // 请求通知权限
        if (Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // ═══════════════════════════════════════════
    //  UI 更新 (rAF 节流)
    // ═══════════════════════════════════════════
    let uiPending = false;

    function refreshUI() {
        if (uiPending) return;
        uiPending = true;
        requestAnimationFrame(() => {
            uiPending = false;
            const shadow = _shadowRef;
            if (!shadow) return;
            const $ = id => shadow.getElementById(id);

            const stEl = $('st');
            if (stEl) {
                stEl.className = 'st st-' + state.status;
                const isTurbo = state.stats.startTime && (performance.now() - state.stats.startTime) < CFG.turboSec * 1000;
                stEl.textContent = state.status === 'idle' ? '等待中'
                    : state.status === 'retrying' ? `${isTurbo ? '⚡极速' : ''}重试中... ${state.count}/${CFG.maxRetry}`
                    : state.status === 'success' ? `成功! bizId=${state.bizId}`
                    : `失败 (${state.count}次)`;
            }

            const capEl = $('cap');
            if (capEl) {
                capEl.textContent = state.captured
                    ? `已捕获: ${state.captured.method} ...${state.captured.url.split('?')[0].slice(-30)}`
                    : '请先点一次购买按钮';
            }

            const cntEl = $('s-cnt'); if (cntEl) cntEl.textContent = state.count;
            const okEl = $('s-ok'); if (okEl) okEl.textContent = state.stats.success;
            const errEl = $('s-err'); if (errEl) errEl.textContent = state.stats.errors;

            const goBtn = $('b-go');
            const stopBtn = $('b-stop');
            if (goBtn && stopBtn) {
                goBtn.style.display = state.status === 'retrying' ? 'none' : '';
                stopBtn.style.display = state.status === 'retrying' ? '' : 'none';
            }
        });
    }

    function appendLogDOM(entry) {
        const shadow = _shadowRef;
        if (!shadow) return;
        const el = shadow.getElementById('logs');
        if (!el) return;
        const div = document.createElement('div');
        div.className = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : entry.msg.includes('成功') ? 'ok' : 'info';
        div.textContent = `${entry.ts} ${entry.msg}`;
        el.appendChild(div);
        while (el.children.length > CFG.logMax) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
    }

    // ═══════════════════════════════════════════
    //  离开保护
    // ═══════════════════════════════════════════
    window.addEventListener('beforeunload', e => {
        if (state.status === 'retrying') {
            e.preventDefault();
            e.returnValue = '抢购正在进行中，确定要离开吗？';
        }
    });

    // ═══════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════
    console.log('[GLM] v4.0 已注入');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
})();
