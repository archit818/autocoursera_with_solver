chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    const urlString = changeInfo.url || tab?.url;
    if (!urlString) return;

    let url;
    try { url = new URL(urlString); } catch (_) { return; }
    if (!url.hostname.endsWith('coursera.org') || !url.pathname.startsWith('/learn/')) return;

    const isAttempt = /\/attempt(?:\/|$)/i.test(url.pathname);
    if (!isAttempt) return;

    // Trigger on SPA pushState URL changes or initial page load complete
    if (changeInfo.url || changeInfo.status === 'complete') {
        let retries = 3;
        function sendAttempt() {
            chrome.tabs.sendMessage(tabId, { action: 'attempt' }, function () {
                if (chrome.runtime.lastError && retries > 0) {
                    retries--;
                    setTimeout(sendAttempt, 1000);
                }
            });
        }
        sendAttempt();
    }
});


chrome.runtime.onInstalled.addListener(function () {
    chrome.tabs.query({ url: "https://www.coursera.org/*" }, function (tabs) {
        tabs.forEach(function (tab) {
            if (tab.id !== undefined) chrome.tabs.reload(tab.id);
        });
    });
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message?.action === 'geminiListModels') {
        fetchGeminiModels(message.apiKey)
            .then(models => sendResponse({ ok: true, models }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    if (message?.action === 'geminiGenerate') {
        generateWithGemini(message)
            .then(text => sendResponse({ ok: true, text }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }

    return false;
});

async function fetchGeminiModels(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new Error('Gemini API key is required to list models.');
    }

    const trimmedKey = apiKey.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
        response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
            {
                method: 'GET',
                headers: {
                    'x-goog-api-key': trimmedKey,
                },
                signal: controller.signal,
            }
        );
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Request timed out while fetching models.');
        throw new Error(`Could not reach Gemini API: ${error.message}`);
    } finally {
        clearTimeout(timeout);
    }

    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch (_) { /* handled below */ }

    if (!response.ok) {
        throw new Error(data?.error?.message || `Failed to fetch models (HTTP ${response.status}).`);
    }

    if (!Array.isArray(data?.models)) {
        throw new Error('Unexpected response format from Gemini API.');
    }

    // Filter for models that support generateContent
    return data.models
        .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => {
            const id = (m.name || '').replace(/^models\//, '').trim();
            return {
                id,
                displayName: m.displayName || id,
                description: m.description || '',
            };
        });
}

async function generateWithGemini({ apiKey, model, prompt, responseMimeType }) {
    if (!apiKey) throw new Error('Gemini API key is missing.');
    const cleanModel = (model || '').replace(/^models\//, '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(cleanModel)) throw new Error('Invalid Gemini model name.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Gemini prompt is empty.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
        response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        responseMimeType: responseMimeType || 'application/json',
                    },
                }),
                signal: controller.signal,
            }
        );
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Gemini request timed out.');
        throw new Error(`Could not reach Gemini: ${error.message}`);
    } finally {
        clearTimeout(timeout);
    }

    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch (_) { /* handled below */ }
    if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini API request failed (HTTP ${response.status}).`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned no answer content.');
    return text;
}
