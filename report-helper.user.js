// ==UserScript==
// @name         中南大学金工实习答题助手
// @namespace    local.csu.report-helper
// @version      1.1.0
// @description  题库自动勾选、手动生成 AI 答案、最终选择记录；成功提交后归档本轮。
// @match        http://szgxjx.csu.edu.cn/zndxstudent/*
// @match        https://szgxjx.csu.edu.cn/zndxstudent/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    const BANK = /*__QUESTION_BANK__*/[{"title": "一小时有多少分钟？", "options": ["60", "100"], "answer": "A", "page": 1, "endPage": 1}];
    const normalize = value => String(value ?? '').normalize('NFKC')
        .replace(/\s+/g, '').replace(/[，、]/g, ',').replace(/[。]/g, '.')
        .replace(/[；]/g, ';').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
        .replace(/[。.;；,，]+$/g, '');
    const meaning = text => {
        const value = normalize(text);
        if (['对', '正确', '是', '√', '✓'].includes(value)) return 'TRUE';
        if (['错', '错误', '否', '×', '✗'].includes(value)) return 'FALSE';
        return value;
    };
    const index = new Map();
    for (const entry of BANK) {
        const key = normalize(entry.title);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(entry);
    }
    function matchQuestion(question) {
        const candidates = index.get(normalize(question.title)) || [];
        const mapped = [];
        for (const entry of candidates) {
            if (entry.options.length !== question.options.length) continue;
            if (JSON.stringify(entry.options.map(meaning).sort()) !==
                JSON.stringify(question.options.map(option => meaning(option.text)).sort())) continue;
            const positions = [...entry.answer].map(letter => question.options
                .map((option, i) => meaning(option.text) === meaning(entry.options[letter.charCodeAt(0)-65]) ? i : -1)
                .filter(i => i >= 0));
            if (positions.some(items => items.length !== 1)) continue;
            const answer = positions.map(items => items[0]).sort((a,b) => a-b);
            mapped.push({answer, page: entry.page, endPage: entry.endPage});
        }
        if (!mapped.length) return {status: candidates.length ? '匹配不确定' : '未匹配'};
        if (new Set(mapped.map(item => JSON.stringify(item.answer))).size !== 1) return {status: '匹配不确定'};
        return {status: '已匹配', ...mapped[0]};
    }
    function result(question) {
        if (!question.selected.length) return '未作答';
        if (question.match.status !== '已匹配') return question.match.status;
        const correct = question.match.answer.map(i => question.options[i].id).sort();
        return JSON.stringify([...question.selected].sort()) === JSON.stringify(correct) ? '与题库一致' : '与题库不一致';
    }
    function updateSelection(round, id, selected) {
        if (!round || round.finishedAt) return false;
        const question = round.questions.find(item => item.id === String(id));
        if (!question) return false;
        const allowed = new Set(question.options.map(option => option.id));
        const next = [...new Set(selected.map(String))].filter(id => allowed.has(id));
        if (JSON.stringify([...question.selected].sort()) === JSON.stringify([...next].sort())) return false;
        question.selected = next;
        question.updatedAt = new Date().toISOString();
        return true;
    }
    function finishRound(round, response, submitType) {
        if (!round || round.finishedAt || Number(response?.status) !== 200 || String(submitType) !== '2') return false;
        round.finishedAt = new Date().toISOString();
        return true;
    }
    function decodeJson(value) {
        if (value !== null && typeof value === 'object') return {value};
        if (typeof value !== 'string') return {error: '内容为空'};
        const text = value.replace(/^\uFEFF/, '').replace(/^\)\]\}',?\r?\n/, '').trim();
        if (!text) return {error: '内容为空'};
        try { return {value: JSON.parse(text)}; }
        catch { return {error: 'JSON 内容不完整或格式无效'}; }
    }
    function roundCsv(round) {
        const rows = [['轮次状态','开始时间','提交时间','作答记录ID','题型','题号','题目','全部选项','最终选择','题库答案','PDF页码','核对情况','最后改选时间']];
        for (const question of round.questions) rows.push([
            round.finishedAt ? '已成功提交' : '答题中', round.startedAt, round.finishedAt || '', round.recordId,
            question.type, question.number, question.title,
            question.options.map(option => `${option.letter}. ${option.text}`).join('；'),
            answerText(question, question.selected), referenceText(question), question.match.page || '',
            result(question), question.updatedAt || ''
        ]);
        const cell = value => {
            let text = String(value ?? '');
            if (/^\s*[=+@-]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        };
        return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
    }
    // Node only: exercise the same matching and round logic used by the userscript.
    if (typeof module === 'object' && module.exports) {
        module.exports = {BANK, normalize, matchQuestion, result, updateSelection, finishRound, decodeJson, roundCsv};
        return;
    }

    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const STORAGE = 'csu-report-helper-v1';
    const ROOTS = 'app-report-exame .single-question, app-report-exame .multiple-question';
    let bundle = null, storageKey = '', pendingPaper = null, sessionFinished = false;
    let host, shadow, hint, shownRoot, summaryOpen = false, previousView = false;
    let notice = '等待网页加载试卷…', storageError = '', blockedReason = '', responseError = '', lastHint = '', lastSummary = '';
    const bindings = new WeakMap(), domSelections = new WeakMap();
    const activeRoute = () => /^#\/report-exame(?:\?|$)/.test(location.hash);
    const routeKey = () => {
        const params = new URLSearchParams(location.hash.split('?')[1] || '');
        return ['tId', 'wId', 'rId'].map(key => params.get(key) || '').join('/');
    };
    const plain = value => {
        // Inert parsing: never insert server/PDF markup into the live document.
        const template = document.createElement('template');
        template.innerHTML = String(value ?? '');
        return template.content.textContent || '';
    };
    function account() {
        const text = document.querySelector('app-report-exame .personmsg')?.textContent?.trim();
        if (!text) return '';
        return text.match(/\d{5,}/g)?.at(-1) || normalize(text);
    }
    function save() {
        if (!bundle || !storageKey) return;
        try { GM_setValue(storageKey, JSON.stringify(bundle)); storageError = ''; }
        catch (error) { storageError = '本地保存失败，请勿关闭页面：' + error.message; }
    }
    function read(key) {
        try { return JSON.parse(GM_getValue(key, 'null')); }
        catch (error) { storageError = '读取本地记录失败：' + error.message; return null; }
    }
    function ingestPaper(payload) {
        if (!activeRoute() || sessionFinished || Number(payload?.status) !== 200) return;
        const data = payload.datas, paper = data?.paper;
        const decoded = decodeJson(paper?.pText);
        if (decoded.error) { responseError = `试卷字段 pText：${decoded.error}，尚未读取题目。`; return; }
        const content = decoded.value;
        if (!Array.isArray(content?.qCateList)) { responseError = '试卷字段 pText 缺少题目列表，尚未读取题目。'; return; }
        responseError = '';
        const user = account();
        if (!user) { pendingPaper = payload; notice = '试卷已读取，等待网页显示账户信息…'; return; }
        pendingPaper = null;
        const key = `${STORAGE}:${encodeURIComponent(user)}:${routeKey()}`;
        if (storageKey !== key) { storageKey = key; bundle = read(key) || {current: null, previous: null}; }
        const recordId = String(paper.reportRecordId || data.id || '');
        if (!recordId) { notice = '无法识别作答记录，暂不记录，避免混入其他轮次。'; return; }
        if (!bundle.current || bundle.current.finishedAt || bundle.current.recordId !== recordId) {
            // A changed server ID alone is not a successful submission; keep the unfinished record.
            if (bundle.current && !bundle.current.finishedAt) {
                blockedReason = '网站作答记录已变化，当前轮尚未收到提交成功结果；已保留原记录，暂停新题记录。';
                return;
            }
            if (bundle.current) bundle.previous = bundle.current;
            bundle.current = {recordId, startedAt: new Date().toISOString(), finishedAt: null, questions: []};
        }
        blockedReason = '';
        const round = bundle.current;
        round.project ||= content.paperName || document.querySelector('.bot_report')?.textContent.trim();
        round.showScore = !!content.showResult;
        let order = 0;
        for (const category of content.qCateList) {
            for (const [i, source] of (category.questionList || []).entries()) {
                order++;
                if (round.questions.some(question => question.id === String(source.id))) continue;
                const options = (source.qOptionList || []).map((option, i) => ({
                    id: String(option.id), letter: String.fromCharCode(65+i), text: plain(option.oText)
                }));
                const selected = Array.isArray(source.answers) ? source.answers.map(String) : [];
                const question = {id: String(source.id), type: category.qCateName || '选择题',
                    number: i+1, order, title: plain(source.qText), options,
                    selected: selected.filter(id => options.some(option => option.id === id)), updatedAt: null};
                question.match = matchQuestion(question);
                round.questions.push(question);
            }
        }
        notice = `本轮已记录 ${round.questions.filter(q => q.selected.length).length}/${round.questions.length} 题`;
        save();
    }
    function optionElements(root) { return [...root.querySelectorAll('.dar_options')]; }
    function bindRoots() {
        const round = bundle?.current;
        if (!round || round.finishedAt) return;
        const used = new Set();
        for (const root of document.querySelectorAll(ROOTS)) {
            const old = bindings.get(root);
            if (old && round.questions.includes(old)) { used.add(old.id); continue; }
            const title = normalize(root.querySelector('.question-subject')?.textContent);
            const options = optionElements(root).map(node => normalize(node.querySelector('.dar_optext')?.textContent));
            const question = round.questions.find(q => !used.has(q.id) && normalize(q.title) === title &&
                q.options.length === options.length && q.options.every((o, i) => normalize(o.text) === options[i]));
            if (question) { bindings.set(root, question); used.add(question.id); }
        }
    }
    function snapshot(forceRoot, forceAll = false) {
        if (!activeRoute() || blockedReason || !bundle?.current || bundle.current.finishedAt) return;
        bindRoots();
        let changed = false;
        for (const root of document.querySelectorAll(ROOTS)) {
            const question = bindings.get(root);
            if (!question || !bundle.current.questions.includes(question)) continue;
            const selected = optionElements(root).flatMap((node, i) =>
                node.querySelector('.actradio, input:checked') && question.options[i] ? [question.options[i].id] : []);
            const serialized = JSON.stringify(selected);
            const before = domSelections.get(root);
            // On refresh, keep the locally recorded answer if the server has an older value.
            if (forceAll || (before !== undefined && before !== serialized) || root === forceRoot) {
                changed = updateSelection(bundle.current, question.id, selected) || changed;
            }
            domSelections.set(root, serialized);
        }
        if (changed) save();
    }
    function safe(action) { try { return action(); } catch (error) { notice = '助手读取失败：' + error.message; } }
    const endpoint = url => {
        try { return new URL(String(url), location.href).pathname.match(/\/classroom\/report\/multiple\/student\/(paper|answer|submit)\/?$/)?.[1]; }
        catch { return null; }
    };
    const parseBody = body => {
        if (typeof body === 'string') { try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); } }
        if (body instanceof URLSearchParams) return Object.fromEntries(body);
        return body || {};
    };
    function requestContext(kind, body) {
        if (!kind || !activeRoute()) return null;
        snapshot(undefined, kind === 'submit');
        return {kind, body: parseBody(body), route: routeKey(), round: bundle?.current,
            submittedQuestions: kind === 'submit' && bundle?.current
                ? JSON.parse(JSON.stringify(bundle.current.questions)) : null};
    }
    function responseReceived(context, payload, httpStatus) {
        if (!context || context.route !== routeKey() || !activeRoute() || httpStatus < 200 || httpStatus >= 300) return;
        if (context.kind === 'paper') ingestPaper(payload);
        if (context.kind === 'submit' && context.round === bundle?.current &&
            finishRound(context.round, payload, context.body.submitType)) {
            context.round.questions = context.submittedQuestions;
            context.round.project ||= payload.datas?.paperName;
            if (context.round.showScore) context.round.score = payload.datas?.finalScore;
            sessionFinished = true;
            notice = '本轮已成功提交，最终选择已归档。';
            save();
        }
    }
    function receiveRaw(context, raw, httpStatus) {
        if (!context || context.route !== routeKey() || !activeRoute() || httpStatus < 200 || httpStatus >= 300) return;
        const decoded = decodeJson(raw);
        if (decoded.error) {
            responseError = context.kind === 'paper'
                ? `试卷接口响应：${decoded.error}，等待网站提供有效试卷。`
                : `提交接口响应：${decoded.error}，尚未确认提交成功，保留本轮记录。`;
            return;
        }
        responseError = '';
        responseReceived(context, decoded.value, httpStatus);
    }
    // Observe only requests already made by the website; preserve their arguments and results.
    const xhrPrototype = page.XMLHttpRequest.prototype;
    const originalOpen = xhrPrototype.open, originalSend = xhrPrototype.send;
    const requests = new WeakMap();
    xhrPrototype.open = function (method, url, ...rest) {
        requests.set(this, {kind: endpoint(url)});
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };
    xhrPrototype.send = function (body) {
        const context = safe(() => requestContext(requests.get(this)?.kind, body));
        // answer responses are not needed: choices come from the page, not the save acknowledgement.
        if (context && context.kind !== 'answer') {
            let captured = false;
            const capture = () => {
                if (captured || this.readyState !== 4) return;
                captured = true;
                this.removeEventListener('readystatechange', ready);
                const raw = this.responseType === 'json' ? this.response : this.responseText;
                receiveRaw(context, raw, this.status);
            };
            // Read before the website's load callback can reuse or clear its XHR object.
            const ready = () => safe(capture);
            this.addEventListener('readystatechange', ready);
            this.addEventListener('load', () => {safe(capture); this.removeEventListener('readystatechange', ready);}, {once: true});
            this.addEventListener('loadend', () => this.removeEventListener('readystatechange', ready), {once: true});
        }
        return Reflect.apply(originalSend, this, arguments);
    };
    if (page.fetch) {
        const originalFetch = page.fetch;
        page.fetch = function (input, init) {
            const kind = endpoint(typeof input === 'string' || input instanceof URL ? input : input.url);
            const context = safe(() => requestContext(kind, init?.body));
            const bodyPromise = context && context.kind !== 'answer' && !init?.body && typeof input?.clone === 'function'
                ? input.clone().text() : null;
            const promise = Reflect.apply(originalFetch, this, arguments);
            if (context && context.kind !== 'answer') promise.then(response => {
                response.clone().text().then(async raw => {
                    if (bodyPromise) context.body = parseBody(await bodyPromise);
                    safe(() => receiveRaw(context, raw, response.status));
                }).catch(() => {});
            }, () => {});
            return promise;
        };
    }

    function element(tag, text, parent) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        parent?.append(node);
        return node;
    }
    function answerText(question, ids) {
        return question.options.filter(option => ids.includes(option.id))
            .map(option => `${option.letter}. ${option.text}`).join('；') || '未作答';
    }
    function referenceText(question) {
        const match = question.match;
        if (match.status !== '已匹配') return match.status;
        return answerText(question, match.answer.map(i => question.options[i].id));
    }
    function mount() {
        if (host?.isConnected || !document.body) return;
        host = element('div'); host.id = 'csu-report-helper';
        shadow = host.attachShadow({mode: 'open'});
        const style = element('style', undefined, shadow);
        style.textContent = `:host{all:initial;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#243247}:host([hidden]){display:none!important}
            *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #b8cce3;border-radius:5px;background:white;color:#17538f;padding:5px 12px}
            button:hover{background:#edf5ff}button:focus-visible{outline:2px solid #1976d2}button[aria-pressed=true]{background:#1976d2;color:white}
            .toolbar{position:fixed;bottom:16px;right:20px;z-index:10000;background:white;border:1px solid #bdd4ed;border-radius:8px;padding:9px 12px;box-shadow:0 3px 14px #263f5b20;max-width:460px}
            .status{font-size:12px;margin-right:10px}.error{color:#b42318}.overlay{position:fixed;inset:0;background:#142b4666;z-index:10001;display:grid;place-items:center;padding:24px}
            .dialog{background:#fff;border-radius:10px;width:min(1250px,96vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 60px #13294555}
            .topline{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #dae4ef;gap:12px}h2{margin:0;font-size:18px}
            .tabs{display:flex;gap:8px;padding:12px 20px}.counts{padding:0 20px 12px;color:#52677e;font-size:13px}.scroll{overflow:auto;padding:0 20px 20px}
            table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}th,td{border:1px solid #dce5ef;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
            th{background:#eff5fc;position:sticky;top:0}th:nth-child(1){width:10%}th:nth-child(2){width:30%}th:nth-child(3),th:nth-child(4){width:22%}th:nth-child(5){width:16%}
            .good{color:#137447}.bad{color:#b42318}small{display:block;color:#61748b} [hidden]{display:none!important}
            @media(max-width:700px){.toolbar{max-width:90vw}.overlay{padding:8px}.dialog{width:98vw}.scroll{padding:0 8px 12px}table{min-width:740px}}`;
        const toolbar = element('div', undefined, shadow); toolbar.className = 'toolbar';
        const status = element('span', '', toolbar); status.className = 'status';
        const button = element('button', '本轮汇总', toolbar);
        button.onclick = () => { snapshot(); summaryOpen = true; previousView = false; lastSummary = ''; renderSummary(); };
        const overlay = element('div', undefined, shadow); overlay.className = 'overlay'; overlay.hidden = true;
        const dialog = element('section', undefined, overlay); dialog.className = 'dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '答题记录汇总');
        const top = element('div', undefined, dialog); top.className = 'topline';
        element('h2', '答题记录 · 题库核对', top);
        const close = element('button', '关闭', top);
        const dismiss = () => {summaryOpen = false; overlay.hidden = true; button.focus();};
        close.onclick = dismiss;
        overlay.onclick = event => { if (event.target === overlay) dismiss(); };
        overlay.onkeydown = event => {
            if (event.key === 'Escape') dismiss();
            if (event.key === 'Tab') {
                const buttons = [...dialog.querySelectorAll('button')];
                if (event.shiftKey && shadow.activeElement === buttons[0]) {event.preventDefault(); buttons.at(-1).focus();}
                else if (!event.shiftKey && shadow.activeElement === buttons.at(-1)) {event.preventDefault(); buttons[0].focus();}
            }
        };
        document.body.append(host);
    }
    function renderSummary() {
        if (!shadow) return;
        const overlay = shadow.querySelector('.overlay'); overlay.hidden = !summaryOpen;
        if (!summaryOpen) return;
        const round = previousView ? bundle?.previous : bundle?.current;
        const signature = JSON.stringify([previousView, round]);
        if (signature === lastSummary) return;
        lastSummary = signature;
        const dialog = shadow.querySelector('.dialog');
        for (const node of dialog.querySelectorAll('.tabs,.counts,.scroll')) node.remove();
        const tabs = element('div', undefined, dialog); tabs.className = 'tabs';
        for (const [text, previous] of [['本轮', false], ['上一轮', true]]) {
            const button = element('button', text, tabs); button.setAttribute('aria-pressed', String(previous === previousView));
            button.onclick = () => {previousView = previous; renderSummary();};
        }
        const exportButton = element('button', '导出 CSV', tabs);
        exportButton.disabled = !round?.questions.length;
        exportButton.onclick = () => {
            if (!previousView) snapshot();
            const selectedRound = previousView ? bundle?.previous : bundle?.current;
            if (!selectedRound?.questions.length) return;
            const url = URL.createObjectURL(new Blob([roundCsv(selectedRound)], {type:'text/csv;charset=utf-8'}));
            const link = element('a', undefined, shadow);
            link.href = url;
            const project = String(selectedRound.project || '未知项目').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80);
            const score = selectedRound.score == null || selectedRound.score === '' ? '成绩未公布' : Number(selectedRound.score)+'分';
            link.download = `${project}_${score}_答题记录_${previousView ? '上一轮' : '本轮'}_${selectedRound.startedAt.replace(/[:.]/g,'-')}.csv`;
            link.hidden = true;
            link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        const counts = element('div', undefined, dialog); counts.className = 'counts';
        if (!round) {counts.textContent = '暂无该轮记录。'; return;}
        const stats = {};
        for (const question of round.questions) {const state = result(question); stats[state] = (stats[state] || 0)+1;}
        const time = new Date(round.finishedAt || round.startedAt).toLocaleString('zh-CN');
        counts.textContent = `${round.finishedAt ? '已成功提交' : '答题中'} · ${time} · 共 ${round.questions.length} 题 · ` +
            Object.entries(stats).map(([state,count]) => `${state} ${count}`).join(' / ');
        const scroll = element('div', undefined, dialog); scroll.className = 'scroll';
        const table = element('table', undefined, scroll), thead = element('thead', undefined, table), header = element('tr', undefined, thead);
        for (const title of ['题型 / 题号','题目','最终选择','题库答案','核对情况']) element('th', title, header);
        const tbody = element('tbody', undefined, table);
        for (const question of round.questions) {
            const row = element('tr', undefined, tbody);
            element('td', `${question.type} ${question.number}`, row);
            element('td', question.title, row);
            const selected = element('td', answerText(question, question.selected), row);
            if (question.updatedAt) element('small', '最后改选：' + new Date(question.updatedAt).toLocaleTimeString('zh-CN'), selected);
            const reference = element('td', referenceText(question), row);
            if (question.match.page) element('small', `PDF 第 ${question.match.page} 页`, reference);
            const state = result(question), cell = element('td', state, row);
            cell.className = state === '与题库一致' ? 'good' : state === '与题库不一致' ? 'bad' : '';
        }
        shadow.querySelector('.topline button').focus();
    }
    const keyName = 'csu-deepseek-key';
    GM_registerMenuCommand('设置 DeepSeek API Key', () => {
        const input = window.prompt('输入 DeepSeek 官方 API Key，留空保存可清除');
        if (input !== null) GM_setValue(keyName, input.trim());
    });
    function fill(root, q, indices) {
        if (bundle?.current?.finishedAt || blockedReason || root.hidden || !root.isConnected ||
            !root.getClientRects().length || bindings.get(root) !== q || !bundle.current.questions.includes(q)) return;
        const rows = optionElements(root);
        if (rows.length !== q.options.length || root.querySelector('.actradio,.disabled') || q.selected.length) return;
        for (const index of indices) rows[index].querySelector('.dar_optext')?.click();
        snapshot(root);
    }
    function generate(root, q, button, label) {
        const key = GM_getValue(keyName, '');
        if (!key) { label.textContent = '请在油猴菜单中设置 DeepSeek API Key'; return; }
        if (q.aiAnswer) { fill(root,q,q.aiAnswer); return; }
        button.disabled = true;
        label.textContent = 'DeepSeek 正在生成…';
        const fail = msg => {button.disabled = false; label.textContent = msg;};
        GM_xmlhttpRequest({method:'POST',url:'https://api.deepseek.com/chat/completions',anonymous:true,
            headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},timeout:60000,
            data:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},messages:[
                {role:'system',content:'根据题型解答题目。只输出 JSON 数组，元素为所选选项的大写字母，例如 ["A"]。'},
                {role:'user',content:JSON.stringify({type:q.type,title:q.title,options:q.options.map(o=>o.letter+'. '+o.text)})}]}),
            onerror:()=>fail('连接失败，可重试'),ontimeout:()=>fail('请求超时，可重试'),
            onload:r=>{
                if (r.status !== 200) return fail('DeepSeek 请求失败（HTTP '+r.status+'）');
                try {
                    const letters = JSON.parse(JSON.parse(r.responseText).choices[0].message.content.trim());
                    if (!Array.isArray(letters) || !letters.length || new Set(letters).size !== letters.length ||
                        (!root.classList.contains('multiple-question') && letters.length !== 1)) throw Error();
                    const indices = letters.map(letter=>q.options.findIndex(o=>o.letter===letter));
                    if (indices.includes(-1)) throw Error();
                    if (!bundle?.current?.questions.includes(q) || bundle.current.finishedAt) return;
                    q.aiAnswer = indices; save(); fill(root,q,indices); label.textContent = ''; button.disabled = false; button.textContent = '使用已生成答案'; lastHint=''; safe(tick);
                } catch {fail('返回的选项无法识别，可重试');}
            }});
    }
    function renderHint() {
        const root = [...document.querySelectorAll(ROOTS)].find(node => !node.hidden && node.getClientRects().length);
        const question = root && bindings.get(root);
        if (!root || !question || !bundle?.current) {hint?.remove(); shownRoot = null; lastHint = ''; return;}
        if (root !== shownRoot || !hint?.isConnected) {
            hint?.remove(); hint = element('details'); hint.open = true;
            hint.style.cssText = 'margin:12px 0;padding:8px 12px;border:1px solid #b8d6ef;border-radius:6px;background:#f0f7ff;color:#17538f;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;white-space:normal;overflow-wrap:anywhere';
            element('summary', '答题助手 · '+(question.match.page ? '题库已匹配' : '可咨询 DeepSeek'), hint).style.cursor = 'pointer';
            element('div', '', hint); element('div', '', hint);
            const header = root.querySelector('.header');
            if (header) header.after(hint); else root.prepend(hint);
            shownRoot = root; lastHint = '';
            if (question.match.page && !question.autoTried && !bundle.current.finishedAt) {
                question.autoTried = true; save(); fill(root,question,question.match.answer);
            } else if (!question.match.page && !bundle.current.finishedAt) {
                const button = element('button','生成 AI 答案',hint);
                const label = element('small','',hint);
                if (question.aiAnswer) button.textContent = '使用已生成答案';
                button.type='button';
                button.onclick=()=>generate(root,question,button,label);
            }
        }
        const reference = question.aiAnswer ? 'DeepSeek · '+answerText(question,question.aiAnswer.map(i=>question.options[i].id)) : referenceText(question), state = result(question);
        const text = JSON.stringify([reference, state, question.selected]);
        if (lastHint === text) return;
        lastHint = text;
        hint.children[1].textContent = `参考答案：${reference}` + (question.match.page ? `（PDF 第 ${question.match.page} 页）` : '');
        hint.children[2].textContent = `已记录：${answerText(question, question.selected)} · ${state}`;
    }
    function tick() {
        if (!activeRoute()) { if (host) host.hidden = true; hint?.remove(); return; }
        mount(); if (host) host.hidden = false;
        if (pendingPaper) ingestPaper(pendingPaper);
        snapshot();
        if (bundle?.current && !sessionFinished) {
            const round = bundle.current;
            notice = `已记录 ${round.questions.filter(q => q.selected.length).length}/${round.questions.length} 题 · 改选自动保存`;
        }
        if (shadow) {
            const status = shadow.querySelector('.status'), text = storageError || blockedReason || responseError || notice;
            if (status.textContent !== text) status.textContent = text;
            status.classList.toggle('error', !!storageError || !!blockedReason || !!responseError);
        }
        renderHint(); renderSummary();
    }
    // Capture before website navigation, then read again after its click/change handlers update the DOM.
    document.addEventListener('click', event => {
        if (!activeRoute() || event.composedPath().includes(host)) return;
        safe(() => snapshot());
        const root = event.target.closest?.('.single-question,.multiple-question');
        setTimeout(() => safe(() => { snapshot(root); tick(); }), 0);
    }, true);
    document.addEventListener('change', event => {
        const root = event.target.closest?.('.single-question,.multiple-question');
        setTimeout(() => safe(() => snapshot(root)), 0);
    }, true);
    window.addEventListener('pagehide', () => safe(() => { snapshot(); save(); }));
    window.addEventListener('hashchange', () => {
        if (activeRoute()) {bundle = null; storageKey = ''; pendingPaper = null; sessionFinished = false; blockedReason = ''; responseError = ''; notice = '等待网页加载试卷…';}
        safe(tick);
    });
    setInterval(() => safe(tick), 350);
    if (document.readyState !== 'loading') safe(tick);
    else document.addEventListener('DOMContentLoaded', () => safe(tick), {once: true});
})();
