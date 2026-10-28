/**
 * Auto Coursera v2.2.1 - Coursera page integration.
 *
 * Bulk completion intentionally handles activities that Coursera exposes as
 * passive progress: lectures and readings. Graded and interactive activities
 * are reported as unsupported instead of being counted as completed.
 */
(function () {
    'use strict';

    const BASE = 'https://www.coursera.org';
    const state = {
        courseId: null,
        userId: null,
        slug: null,
        interceptedItems: [],
        running: false,
    };

    let progressOverlay = null;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.source !== 'AUTOCOURSERA_INTERCEPTOR') return;
        const { type, payload = {} } = event.data;

        if (type === 'COURSE_ID' && payload.courseId) state.courseId = String(payload.courseId);
        if (type === 'USER_ID' && payload.userId) state.userId = String(payload.userId);
        if (type === 'SLUG' && payload.slug) syncSlug(String(payload.slug));
        if (type === 'COURSE_ITEMS' && Array.isArray(payload.items)) state.interceptedItems = payload.items;
        if (type === 'NAVIGATE') {
            if (typeof checkAndAutoSolve === 'function') {
                setTimeout(() => checkAndAutoSolve(), 500);
            }
        }
        if (type === 'STATE') {
            if (payload.slug) syncSlug(String(payload.slug));
            if (payload.courseId) state.courseId = String(payload.courseId);
            if (payload.userId) state.userId = String(payload.userId);
            if (Array.isArray(payload.items)) state.interceptedItems = payload.items;
        }
    });

    function requestInterceptorState() {
        window.postMessage({ source: 'AUTOCOURSERA_CONTENT', type: 'GET_STATE' }, '*');
    }

    function syncSlug(slug) {
        if (state.slug && state.slug !== slug) {
            state.courseId = null;
            state.interceptedItems = [];
        }
        state.slug = slug;
    }

    function getSlugFromUrl() {
        const match = window.location.pathname.match(/\/learn\/([^/?#]+)/i);
        const slug = match?.[1] || null;
        if (slug) syncSlug(slug);
        return slug;
    }

    function getCsrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)(?:csrf3-token|CSRF3-Token)=([^;]+)/i);
        if (!match) return '';
        try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
    }

    async function courseraFetch(url, options = {}) {
        const {
            timeoutMs = 20000,
            headers: suppliedHeaders = {},
            ...fetchOptions
        } = options;
        const method = String(fetchOptions.method || 'GET').toUpperCase();
        const headers = {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Coursera-Application': 'nautilus',
            'X-Coursera-Version': 'ondemand',
            ...suppliedHeaders,
        };

        if (method !== 'GET' && method !== 'HEAD' && fetchOptions.body && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const csrf = getCsrfToken();
        if (csrf) {
            headers['X-CSRF3-Token'] = csrf;
            headers['X-CSRFToken'] = csrf;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...fetchOptions,
                credentials: 'include',
                headers,
                signal: controller.signal,
            });
            const text = await response.text();
            const trimmed = text.trimStart();
            let data = null;
            if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
                try { data = JSON.parse(text); } catch (_) { /* keep raw text for diagnostics */ }
            }
            return {
                ok: response.ok,
                status: response.status,
                data,
                text,
                isHtml: trimmed.startsWith('<'),
            };
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('Coursera request timed out.');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async function getCourseMaterials(slug) {
        const includes = [
            'modules', 'lessons', 'passableItemGroups', 'passableItemGroupChoices',
            'passableLessonElements', 'items', 'tracks', 'gradePolicy', 'gradingParameters',
        ].join(',');
        const fields = [
            'moduleIds',
            'onDemandCourseMaterialModules.v1(name,slug,lessonIds,optional)',
            'onDemandCourseMaterialLessons.v1(name,slug,elementIds,optional)',
            'onDemandCourseMaterialItems.v2(name,originalName,slug,itemType,graded,contentSummary,isLocked)',
        ].join(',');
        const url = `${BASE}/api/onDemandCourseMaterials.v2/?q=slug&slug=${encodeURIComponent(slug)}` +
            `&includes=${encodeURIComponent(includes)}&fields=${encodeURIComponent(fields)}&showLockedItems=true`;

        try {
            const result = await courseraFetch(url);
            if (!result.ok || !result.data) return { data: null, error: formatHttpError(result) };
            return { data: result.data, error: null };
        } catch (error) {
            return { data: null, error: error.message };
        }
    }

    async function getCourseId(slug, materials) {
        const materialId = materials?.elements?.[0]?.id;
        if (materialId) return String(materialId);
        if (state.courseId) return state.courseId;

        requestInterceptorState();
        await sleep(250);
        if (state.courseId) return state.courseId;

        const urls = [
            `${BASE}/api/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=id,slug`,
            `${BASE}/api/courses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=id,slug`,
        ];
        for (const url of urls) {
            try {
                const result = await courseraFetch(url);
                const id = result.data?.elements?.[0]?.id;
                if (result.ok && id) return String(id);
            } catch (_) { /* try the next documented page API */ }
        }
        return null;
    }

    async function getUserId() {
        if (state.userId) return state.userId;
        requestInterceptorState();
        await sleep(250);
        if (state.userId) return state.userId;

        try {
            const result = await courseraFetch(`${BASE}/api/users.v1?q=me&fields=id`);
            const id = result.data?.elements?.[0]?.id;
            if (result.ok && id !== undefined && id !== null) {
                state.userId = String(id);
                return state.userId;
            }
        } catch (_) { /* DOM fallback below */ }

        for (const script of document.scripts) {
            const text = script.textContent || '';
            if (!text.includes('userId') && !text.includes('email_address')) continue;
            const match = text.match(/"userId"\s*:\s*"?(\d+)"?/) ||
                (text.includes('email_address') ? text.match(/"id"\s*:\s*"?(\d+)"?/) : null);
            if (match) return match[1];
        }
        return null;
    }

    function classifyItem(item) {
        const raw = [
            item?.itemType,
            item?.contentSummary?.typeName,
            item?.type,
        ].filter(Boolean).join(' ').toLowerCase();
        if (/lecture|video/.test(raw)) return 'lecture';
        if (/supplement|reading/.test(raw)) return 'supplement';
        if (/quiz|exam|assessment|peer|programming|graded|assignment/.test(raw)) return 'graded';
        if (/discussion|widget|lab|lti/.test(raw)) return 'interactive';
        return 'unknown';
    }

    function normalizeItems(rawItems) {
        const seen = new Set();
        return (Array.isArray(rawItems) ? rawItems : []).flatMap(item => {
            const id = item?.id || item?.itemId;
            if (!id || seen.has(String(id))) return [];
            seen.add(String(id));
            return [{
                id: String(id),
                name: String(item.name || item.originalName || item.slug || id).trim(),
                type: classifyItem(item),
                raw: item,
            }];
        });
    }

    function getItemsFromMaterials(materials) {
        const linked = materials?.linked || {};
        return normalizeItems(
            linked['onDemandCourseMaterialItems.v2'] ||
            linked['onDemandCourseMaterialItems.v1'] ||
            []
        );
    }

    function getItemsFromDOM(slug) {
        const pattern = new RegExp(`/learn/${escapeRegExp(slug)}/(lecture|supplement|quiz|exam|peer|programming|discussionPrompt|ungradedLab|gradedLti)/([^/?#]+)`, 'i');
        const raw = [];
        document.querySelectorAll('a[href]').forEach(link => {
            const match = (link.getAttribute('href') || '').match(pattern);
            if (!match) return;
            raw.push({
                id: match[2],
                name: link.textContent.trim().slice(0, 100) || match[2],
                itemType: match[1],
            });
        });
        return normalizeItems(raw);
    }

    function mergeItems(...collections) {
        const merged = new Map();
        for (const items of collections) {
            for (const item of normalizeItems(items)) {
                const existing = merged.get(item.id);
                if (!existing || existing.type === 'unknown') merged.set(item.id, item);
            }
        }
        return [...merged.values()];
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function formatHttpError(result) {
        if (!result) return 'No response from Coursera.';
        if (result.isHtml) return `Coursera returned an HTML page (HTTP ${result.status}); the session may have expired.`;
        const apiMessage = result.data?.message || result.data?.error?.message || result.data?.errorCode;
        return apiMessage ? `HTTP ${result.status}: ${apiMessage}` : `HTTP ${result.status}`;
    }

    async function getVideoMeta(courseId, itemId) {
        const fields = encodeURIComponent('onDemandVideos.v1(id,duration,name),disableSkippingForward,startMs,endMs');
        const url = `${BASE}/api/onDemandLectureVideos.v1/${encodeURIComponent(`${courseId}~${itemId}`)}/?includes=video&fields=${fields}`;
        try {
            const result = await courseraFetch(url);
            if (!result.ok || !result.data) return null;
            const video = result.data?.linked?.['onDemandVideos.v1']?.[0] || result.data?.elements?.[0]?.video;
            if (!video?.id) return null;
            return { id: String(video.id), duration: Number(video.duration) || 0 };
        } catch (_) {
            return null;
        }
    }

    async function reportVideoProgress(userId, courseId, video) {
        const progressId = `${userId}~${courseId}~${video.id}`;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 9999999;
        const body = JSON.stringify({ viewedUpTo: Math.max(0, duration - 1000), videoProgressId: progressId });
        for (const method of ['POST', 'PUT']) {
            try {
                const result = await courseraFetch(
                    `${BASE}/api/onDemandVideoProgresses.v1/${encodeURIComponent(progressId)}`,
                    { method, body }
                );
                if (result.ok || result.status === 204) return true;
            } catch (_) { /* try alternate method */ }
        }
        return false;
    }

    async function sendLectureEnded(userId, slug, itemId) {
        const url = `${BASE}/api/opencourse.v1/user/${encodeURIComponent(userId)}` +
            `/course/${encodeURIComponent(slug)}/item/${encodeURIComponent(itemId)}` +
            '/lecture/videoEvents/ended?autoEnroll=false';
        return courseraFetch(url, {
            method: 'POST',
            body: JSON.stringify({ contentRequestBody: {} }),
        });
    }

    async function putProgressState(userId, courseRef, itemId) {
        return courseraFetch(
            `${BASE}/api/opencourse.v1/user/${encodeURIComponent(userId)}` +
            `/course/${encodeURIComponent(courseRef)}/item/${encodeURIComponent(itemId)}/progressState`,
            { method: 'PUT', body: JSON.stringify({ progressState: 'COMPLETED' }) }
        );
    }

    async function markLectureComplete(userId, courseId, slug, itemId) {
        let lastResult;
        try {
            lastResult = await sendLectureEnded(userId, slug, itemId);
            if (lastResult.ok) return { ok: true, method: 'video-ended' };
            if ([401, 403].includes(lastResult.status)) return { ok: false, error: formatHttpError(lastResult) };
        } catch (error) {
            lastResult = null;
        }

        const video = await getVideoMeta(courseId, itemId);
        if (video) {
            await reportVideoProgress(userId, courseId, video);
            for (let attempt = 0; attempt < 3; attempt++) {
                await sleep(1000 + attempt * 500);
                try {
                    lastResult = await sendLectureEnded(userId, slug, itemId);
                    if (lastResult.ok) return { ok: true, method: 'video-progress' };
                    if ([401, 403].includes(lastResult.status)) break;
                } catch (_) { /* use progress-state fallback */ }
            }
        }

        for (const courseRef of [courseId, slug]) {
            try {
                const result = await putProgressState(userId, courseRef, itemId);
                lastResult = result;
                if (result.ok || result.status === 204) return { ok: true, method: 'progress-state' };
                if ([401, 403].includes(result.status)) break;
            } catch (_) { /* try alternate course reference */ }
        }
        return { ok: false, error: formatHttpError(lastResult) };
    }

    async function markSupplementComplete(userId, courseId, itemId) {
        try {
            const result = await courseraFetch(`${BASE}/api/onDemandSupplementCompletions.v1`, {
                method: 'POST',
                body: JSON.stringify({ courseId, itemId, userId: Number(userId) || userId }),
            });
            return result.ok
                ? { ok: true, method: 'supplement-completion' }
                : { ok: false, error: formatHttpError(result) };
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }

    function findQuestionElements() {
        const selectors = [
            'div[data-testid^="part-Submission_"]',
            'div[data-testid*="Question"]',
            'div[role="group"][aria-labelledby*="-legend"]',
            '.rc-FormPartsQuestion',
            '[class*="FormPartsQuestion"]',
            '.rc-Question',
        ];
        let candidates = [...document.querySelectorAll(selectors.join(', '))].filter(element => {
            const testId = element.getAttribute('data-testid') || '';
            if (/CodeExpression/i.test(testId)) return false;
            return Boolean(element.querySelector(
                'input[type="radio"], input[type="checkbox"], input[type="number"], textarea, input[type="text"]'
            ));
        });

        if (!candidates.length) {
            const inputs = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
            const groups = new Set();
            for (const input of inputs) {
                const group = input.closest('fieldset, [role="radiogroup"], [role="group"], [class*="question"], [class*="Question"]') || input.parentElement?.parentElement;
                if (group) groups.add(group);
            }
            candidates = [...groups];
        }

        return candidates.filter(
            element => !candidates.some(other => other !== element && other.contains(element))
        );
    }

    async function waitForQuestionElements(timeoutMs = 15000) {
        const started = Date.now();
        do {
            const elements = findQuestionElements();
            if (elements.length) return elements;
            const elapsed = Math.round((Date.now() - started) / 1000);
            updateOverlay(`Waiting for quiz questions to load... (${elapsed}s)`, 'info');
            await sleep(300);
        } while (Date.now() - started < timeoutMs);
        return [];
    }

    function cleanElementText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll(
            '[data-ai-instructions="true"], [data-testid="content-integrity-instructions"], ' +
            '[data-testid="acknowledgment-checkpoint"], [aria-hidden="true"]'
        ).forEach(hidden => hidden.remove());
        return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function extractQuestion(element, index) {
        const legend = element.querySelector('[data-testid="legend"]');
        const promptElement = legend?.querySelector('[data-testid="cml-viewer"], .rc-CML') ||
            element.querySelector(
                '[id^="prompt-"] [data-testid="cml-viewer"], [data-testid="question-prompt"], ' +
                '.rc-CML, .cml-viewer, [class*="prompt"]'
            );
        const prompt = cleanElementText(promptElement) || `Question ${index + 1}`;

        let optionElements = [...element.querySelectorAll('.rc-Option, [class*="Option"], label')].filter(option =>
            option.querySelector('input[type="radio"], input[type="checkbox"]')
        );
        if (!optionElements.length) {
            const rawInputs = [...element.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
            optionElements = rawInputs.map(input => input.closest('label') || input.parentElement || input);
        }

        const inputs = optionElements.map(option =>
            option.querySelector('input[type="radio"], input[type="checkbox"]')
        ).filter(Boolean);
        const options = optionElements.map((option, optionIndex) => {
            const textElement = option.querySelector('[data-testid="cml-viewer"]');
            const imageText = [...option.querySelectorAll('img')]
                .map(image => image.alt || image.getAttribute('aria-label') || '')
                .filter(Boolean)
                .join(' ');
            return cleanElementText(textElement || option) || imageText || `Option ${optionIndex + 1}`;
        });
        const textInput = element.querySelector('input[type="number"], textarea, input[type="text"]');

        if (!options.length && !textInput) return null;
        return {
            element,
            inputs,
            textInput,
            question: {
                id: `q${index}`,
                prompt,
                options,
                questionType: options.length ? 'mcq' : 'text',
                allowMultiple: inputs.some(input => input.type === 'checkbox'),
            },
        };
    }

    async function clickInputWithVerification(input) {
        let current = input;
        const inputName = input.name;
        const inputValue = input.value;

        function reacquireInput() {
            if (current?.isConnected) return current;
            current = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')].find(candidate =>
                candidate.name === inputName && candidate.value === inputValue
            ) || current;
            return current;
        }

        if (reacquireInput()?.checked) return true;
        for (let attempt = 0; attempt < 3; attempt++) {
            const liveInput = reacquireInput();
            if (!liveInput) return false;
            const target = liveInput.closest('label') || liveInput;
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            target.click();
            liveInput.dispatchEvent(new Event('input', { bubbles: true }));
            liveInput.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(200);
            if (reacquireInput()?.checked) return true;
        }
        return false;
    }

    function findQuizSubmitButton() {
        const direct = document.querySelector(
            'button[data-testid="submit-button"], button[data-track-component="submit_coursework"], ' +
            'button[data-track-component="submit_assignment"], .rc-SubmissionFooter button:last-child'
        );
        if (direct) return direct;
        return [...document.querySelectorAll('button')].find(button =>
            /^(submit|submit quiz|submit assignment)$/i.test(button.textContent.trim())
        ) || null;
    }

    async function solveCurrentPageQuiz() {
        const settings = await getStoredSettings();
        showOverlay();
        if (!settings.apiKey) {
            updateOverlay('Enter your Gemini API key in the extension settings.', 'warning');
            return false;
        }

        setStopButton(false);
        updateOverlay('Reading quiz questions...', 'info');
        const questionElements = await waitForQuestionElements(15000);
        const extracted = questionElements.map(extractQuestion).filter(Boolean);
        if (!extracted.length) {
            updateOverlay('No supported quiz questions were found on this page.', 'warning');
            return false;
        }

        const questions = extracted.map(item => item.question);

        updateOverlay(`Asking Gemini (${settings.model || 'Gemini'}) about ${questions.length} question${questions.length === 1 ? '' : 's'}...`, 'info');
        let answers;
        try {
            answers = await new window.GeminiAI(settings.apiKey, settings.model).solveQuestions(JSON.stringify(questions));
        } catch (error) {
            updateOverlay(`Gemini error: ${error.message}`, 'error');
            return false;
        }

        let selectionFailures = 0;
        for (let index = 0; index < extracted.length; index++) {
            const { inputs, textInput } = extracted[index];
            const answer = answers[index];
            if (!answer) {
                selectionFailures++;
                continue;
            }
            let indices = answer.correctOptionsIndex === undefined
                ? []
                : (Array.isArray(answer.correctOptionsIndex) ? answer.correctOptionsIndex : [answer.correctOptionsIndex]);
            indices = [...new Set(indices.map(Number).filter(Number.isInteger))];
            if (inputs.some(input => input.type === 'radio')) indices = indices.slice(0, 1);
            for (const optionIndex of indices) {
                if (!inputs[optionIndex] || !(await clickInputWithVerification(inputs[optionIndex]))) selectionFailures++;
            }

            if (answer.content !== undefined && textInput) {
                setNativeInputValue(textInput, String(answer.content));
            }
        }

        await sleep(500);

        // Check acknowledgment / honor code checkbox if present
        const ack = document.querySelector(
            '[data-testid="acknowledgment-checkpoint"] input[type="checkbox"], ' +
            'input[name*="honorCode"], input[name*="agreement"], ' +
            '.rc-HonorCodeCheckbox input[type="checkbox"], ' +
            'label[class*="acknowledgment"] input[type="checkbox"]'
        );
        if (ack && !ack.checked) {
            ack.click();
            ack.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(300);
        }

        const submit = findQuizSubmitButton();
        if (!selectionFailures && submit && !submit.disabled) {
            submit.click();
            await sleep(500);
            // Handle optional confirmation dialog (e.g. "Submit Quiz" in a modal)
            const confirmBtn = document.querySelector(
                'div[role="dialog"] button[data-testid="submit-button"], ' +
                'div[role="dialog"] button.rc-ModalSubmitButton'
            );
            if (confirmBtn && !confirmBtn.disabled) {
                confirmBtn.click();
            }
            updateOverlay('Answers filled and submitted! 🎉', 'success');
            return true;
        }
        updateOverlay(
            selectionFailures
                ? `Answers were generated, but ${selectionFailures} selection${selectionFailures === 1 ? '' : 's'} did not stick. Review and submit manually.`
                : 'Answers filled. Review them, then submit manually.',
            'warning'
        );
        return true;
    }

    function setNativeInputValue(input, value) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
        if (descriptor?.set) descriptor.set.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function runFullCourseCompletion() {
        if (state.running) {
            updateOverlay('Completion is already running.', 'warning');
            return;
        }

        state.running = true;
        showOverlay();
        setStopButton(true);

        try {
            const slug = getSlugFromUrl();
            if (!slug) throw new Error('Open a coursera.org/learn/... course page first.');

            updateOverlay(`Loading course structure for ${slug}...`, 'info');
            const { data: materials, error: materialsError } = await getCourseMaterials(slug);
            const courseId = await getCourseId(slug, materials);
            if (!courseId) throw new Error(`Could not determine the course ID.${materialsError ? ` ${materialsError}` : ''}`);
            state.courseId = courseId;

            const userId = await getUserId();
            if (!userId) throw new Error('Could not determine the signed-in Coursera user. Reload the page and confirm you are enrolled.');

            const items = mergeItems(
                getItemsFromMaterials(materials),
                state.interceptedItems,
                getItemsFromDOM(slug)
            );
            if (!items.length) throw new Error(`No course activities were found.${materialsError ? ` ${materialsError}` : ''}`);

            const supported = items.filter(item => item.type === 'lecture' || item.type === 'supplement');
            const unsupported = items.length - supported.length;
            if (!supported.length) throw new Error(`Found ${items.length} activities, but none are supported lectures or readings.`);

            let completed = 0;
            const failures = [];
            for (let index = 0; index < supported.length; index++) {
                if (!state.running) break;
                const item = supported[index];
                updateOverlay(
                    `[${index + 1}/${supported.length}] ${item.name.slice(0, 64)}\n${completed} completed, ${failures.length} failed`,
                    'info'
                );

                const result = item.type === 'lecture'
                    ? await markLectureComplete(userId, courseId, slug, item.id)
                    : await markSupplementComplete(userId, courseId, item.id);
                if (result.ok) completed++;
                else failures.push({ item, error: result.error || 'Unknown Coursera error' });
                await sleep(350);
            }

            if (!state.running) {
                updateOverlay(`Stopped. ${completed} activities completed.`, 'warning');
                return;
            }

            const summary = [
                `${completed}/${supported.length} supported activities completed.`,
                failures.length ? `${failures.length} failed; first error: ${failures[0].error}` : '',
                unsupported ? `${unsupported} graded/interactive activities were left untouched.` : '',
                'Reload the Coursera page to refresh progress.',
            ].filter(Boolean).join('\n');
            updateOverlay(summary, failures.length ? 'warning' : 'success');
        } catch (error) {
            updateOverlay(error.message || String(error), 'error');
        } finally {
            state.running = false;
            setStopButton(false);
        }
    }

    function showOverlay() {
        if (progressOverlay?.isConnected) return;
        document.getElementById('ac-overlay-style')?.remove();

        const style = document.createElement('style');
        style.id = 'ac-overlay-style';
        style.textContent = `
            #ac-overlay{position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
            #ac-panel{box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:18px 20px;border:1px solid #1e3a5f;border-radius:14px;background:#0f172a;color:#f1f5f9;box-shadow:0 24px 64px rgba(0,0,0,.55)}
            #ac-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:#38bdf8;font-size:13px;font-weight:700}
            #ac-close{border:0;background:transparent;color:#94a3b8;font-size:18px;cursor:pointer}
            #ac-msg{min-height:42px;margin-bottom:12px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;color:#7dd3fc}
            #ac-msg.success{color:#86efac} #ac-msg.warning{color:#fde68a} #ac-msg.error{color:#fca5a5}
            #ac-stop{width:100%;padding:8px 16px;border:0;border-radius:7px;background:#dc2626;color:#fff;font-size:12px;font-weight:700;cursor:pointer}
            #ac-stop[hidden]{display:none}
        `;
        (document.head || document.documentElement).appendChild(style);

        progressOverlay = document.createElement('div');
        progressOverlay.id = 'ac-overlay';
        progressOverlay.innerHTML = `
            <div id="ac-panel" role="status" aria-live="polite">
                <div id="ac-header"><span>Auto Coursera</span><button id="ac-close" type="button" aria-label="Close">×</button></div>
                <div id="ac-msg">Starting...</div>
                <button id="ac-stop" type="button">Stop</button>
            </div>`;
        document.body.appendChild(progressOverlay);

        progressOverlay.querySelector('#ac-close').addEventListener('click', () => {
            state.running = false;
            progressOverlay.remove();
            progressOverlay = null;
        });
        progressOverlay.querySelector('#ac-stop').addEventListener('click', () => {
            state.running = false;
            updateOverlay('Stopping after the current request...', 'warning');
        });
    }

    function setStopButton(visible) {
        const button = progressOverlay?.querySelector('#ac-stop');
        if (button) button.hidden = !visible;
    }

    function updateOverlay(message, type = 'info') {
        console.log('[AutoCoursera]', message);
        const element = progressOverlay?.querySelector('#ac-msg');
        if (element) {
            element.textContent = message;
            element.className = type;
        }
    }

    function getStoredSettings() {
        return new Promise(resolve => {
            chrome.storage.local.get(['apiKey', 'model', 'quizEnabled'], result => resolve({
                apiKey: result.apiKey || '',
                model: result.model || 'gemini-2.5-flash',
                quizEnabled: result.quizEnabled === true || result.quizEnabled === 'true',
            }));
        });
    }

    let isAutoSolving = false;
    let lastSolvedUrl = '';

    function isAttemptPage() {
        const path = window.location.pathname.toLowerCase();
        if (/\/attempt(?:\/|$)/.test(path)) return true;
        if (/\/(?:exam|quiz|assignment-submission)\//.test(path) && findQuestionElements().length > 0) return true;
        return false;
    }

    async function checkAndAutoSolve(forced = false) {
        if (!isAttemptPage()) return;
        const currentUrl = window.location.href.split('#')[0].split('?')[0];
        if (!forced && (isAutoSolving || lastSolvedUrl === currentUrl)) return;

        const settings = await getStoredSettings();
        if (!settings.quizEnabled || !settings.apiKey) return;

        isAutoSolving = true;
        lastSolvedUrl = currentUrl;
        console.log('[AutoCoursera] Auto-solve starting for:', currentUrl);
        try {
            await solveCurrentPageQuiz();
        } catch (err) {
            console.error('[AutoCoursera] Auto-solve error:', err);
        } finally {
            isAutoSolving = false;
        }
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const action = typeof message === 'string' ? message : (message?.action || message?.type || '');
        if (action === 'bypass' || action === 'completeCourse') {
            runFullCourseCompletion();
            sendResponse({ ok: true });
            return false;
        }
        if (action === 'autoQuiz' || action === 'solveQuiz') {
            solveCurrentPageQuiz().then(ok => sendResponse({ ok })).catch(error => sendResponse({ ok: false, error: error.message }));
            return true;
        }
        if (action === 'attempt') {
            checkAndAutoSolve(true);
            sendResponse({ ok: true });
            return false;
        }
        if (action === 'stop') {
            state.running = false;
            updateOverlay('Stopping after the current request...', 'warning');
            sendResponse({ ok: true });
            return false;
        }
        return false;
    });

    setTimeout(requestInterceptorState, 300);
    setTimeout(requestInterceptorState, 1500);

    // Initial check on load
    setTimeout(() => checkAndAutoSolve(), 600);
    setTimeout(() => checkAndAutoSolve(), 2500);

    // Watch for SPA URL changes
    window.addEventListener('popstate', () => setTimeout(() => checkAndAutoSolve(), 500));
    window.addEventListener('hashchange', () => setTimeout(() => checkAndAutoSolve(), 500));

    let lastKnownUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastKnownUrl) {
            lastKnownUrl = window.location.href;
            if (isAttemptPage()) {
                setTimeout(() => checkAndAutoSolve(), 500);
            }
        }
    }, 1000);

    console.log('[AutoCoursera] Content script v2.2.1 loaded.');
})();
