/**
 * Auto Coursera — Popup Script
 * Handles UI interactions, dynamic model fetching, settings persistence, and tab messaging.
 */

(function () {
    'use strict';

    // ─── DOM References ───────────────────────────────────────────────────────

    const bypassBtn    = document.getElementById('bypass');
    const autoQuizBtn  = document.getElementById('autoQuiz');
    const quizToggle   = document.getElementById('quizToggel');
    const keyInput     = document.getElementById('key');
    const modelSelect  = document.getElementById('model-select');
    const refreshBtn   = document.getElementById('refresh-models');
    const saveBtn      = document.getElementById('save');
    const keyStatus    = document.getElementById('key-status');

    // Default fallback models (available on Gemini free tier)
    const DEFAULT_MODELS = [
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite' },
        { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
        { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' },
    ];

    // ─── Model Rendering & Grouping ───────────────────────────────────────────

    function renderModels(modelsList, selectedModel) {
        if (!modelsList || !modelsList.length) {
            modelsList = DEFAULT_MODELS;
        }

        const currentSelection = selectedModel || (modelSelect ? modelSelect.value : '') || 'gemini-2.5-flash';
        modelSelect.innerHTML = '';

        const isRecommended = (m) => {
            const id = (m.id || '').toLowerCase();
            // Mainline Flash and Pro models (exclude experimental, thinking, and dated preview snapshots)
            const isExpOrDate = id.includes('-exp') || id.includes('-thinking') || /\d{2}-\d{2}/.test(id);
            const isMainline = (id.includes('flash') || id.includes('pro')) && !isExpOrDate;
            return isMainline;
        };

        const recommended = [];
        const others = [];

        const seen = new Set();
        for (const m of modelsList) {
            if (!m.id || seen.has(m.id)) continue;
            seen.add(m.id);
            if (isRecommended(m)) {
                recommended.push(m);
            } else {
                others.push(m);
            }
        }

        // Sort recommended: Flash models first, then Pro, with higher versions first
        recommended.sort((a, b) => {
            const aFlash = a.id.toLowerCase().includes('flash');
            const bFlash = b.id.toLowerCase().includes('flash');
            if (aFlash && !bFlash) return -1;
            if (!aFlash && bFlash) return 1;
            return b.id.localeCompare(a.id, undefined, { numeric: true, sensitivity: 'base' });
        });

        // Sort others alphabetically
        others.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));

        if (recommended.length > 0) {
            const recGroup = document.createElement('optgroup');
            recGroup.label = '🌟 Recommended (Free Tier)';
            recommended.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.displayName && m.displayName !== m.id
                    ? `${m.displayName} (${m.id})`
                    : m.id;
                recGroup.appendChild(opt);
            });
            modelSelect.appendChild(recGroup);
        }

        if (others.length > 0) {
            const otherGroup = document.createElement('optgroup');
            otherGroup.label = '📦 Other Available Models';
            others.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.displayName && m.displayName !== m.id
                    ? `${m.displayName} (${m.id})`
                    : m.id;
                otherGroup.appendChild(opt);
            });
            modelSelect.appendChild(otherGroup);
        }

        // Restore selected model or preserve custom value
        const optionExists = Array.from(modelSelect.options).some(o => o.value === currentSelection);
        if (optionExists) {
            modelSelect.value = currentSelection;
        } else if (currentSelection) {
            const customOpt = document.createElement('option');
            customOpt.value = currentSelection;
            customOpt.textContent = `${currentSelection} (Custom)`;
            modelSelect.insertBefore(customOpt, modelSelect.firstChild);
            modelSelect.value = currentSelection;
        } else if (modelSelect.options.length > 0) {
            modelSelect.selectedIndex = 0;
        }
    }

    // ─── Dynamic Model Fetching ───────────────────────────────────────────────

    function fetchAvailableModels(apiKey, userTriggered = false) {
        if (!apiKey) {
            if (userTriggered) {
                showToast('⚠️ Please enter your Gemini API key first.');
                keyInput.focus();
            }
            return Promise.resolve(null);
        }

        if (refreshBtn) refreshBtn.classList.add('spinning');
        if (userTriggered) {
            keyStatus.textContent = '⏳ Fetching available models...';
        }

        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'geminiListModels', apiKey }, (response) => {
                if (refreshBtn) refreshBtn.classList.remove('spinning');

                if (chrome.runtime.lastError) {
                    console.warn('[AutoCoursera Popup]', chrome.runtime.lastError.message);
                    if (userTriggered) {
                        keyStatus.textContent = '⚠️ Could not connect to extension worker.';
                        showToast('⚠️ Could not connect to extension service.');
                    }
                    resolve(null);
                    return;
                }

                if (!response?.ok) {
                    const errMsg = response?.error || 'Failed to fetch models.';
                    if (userTriggered) {
                        keyStatus.textContent = `⚠️ ${errMsg}`;
                        showToast(`⚠️ ${errMsg}`);
                    }
                    resolve(null);
                    return;
                }

                const models = response.models || [];
                if (models.length > 0) {
                    chrome.storage.local.set({ cachedModels: models });
                    renderModels(models, modelSelect.value);
                    keyStatus.textContent = `✅ Loaded ${models.length} available models.`;
                    if (userTriggered) {
                        showToast(`✅ Loaded ${models.length} available models.`);
                    }
                } else if (userTriggered) {
                    keyStatus.textContent = '⚠️ No generation models found for this key.';
                }
                resolve(models);
            });
        });
    }

    // ─── Storage helpers ──────────────────────────────────────────────────────

    function saveSettings() {
        const apiKey = keyInput.value.trim();
        const model = modelSelect.value;
        const quizEnabled = quizToggle.checked;

        const settings = {
            apiKey,
            model,
            quizEnabled,
        };

        chrome.storage.local.set(settings, () => {
            saveBtn.textContent = 'Saved ✓';
            saveBtn.classList.add('saved');
            keyStatus.textContent = apiKey ? '✅ Settings saved.' : 'API key cleared.';
            setTimeout(() => {
                saveBtn.textContent = 'Save Settings';
                saveBtn.classList.remove('saved');
            }, 2000);

            if (apiKey) {
                fetchAvailableModels(apiKey, false);
            }
        });
    }

    function loadSettings() {
        chrome.storage.local.get(['apiKey', 'model', 'quizEnabled', 'cachedModels'], (result) => {
            if (result.cachedModels && result.cachedModels.length > 0) {
                renderModels(result.cachedModels, result.model);
            } else {
                renderModels(DEFAULT_MODELS, result.model);
            }

            if (result.apiKey) {
                keyInput.value = result.apiKey;
                keyStatus.textContent = '✅ API key saved.';
                // Refresh models in background to keep list up to date
                fetchAvailableModels(result.apiKey, false);
            }
            if (result.model) {
                modelSelect.value = result.model;
            }
            quizToggle.checked = result.quizEnabled === true;
        });
    }

    // ─── Tab messaging ────────────────────────────────────────────────────────

    function getActiveTab() {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                resolve(tabs[0] || null);
            });
        });
    }

    async function sendToTab(action) {
        const tab = await getActiveTab();
        if (!tab) return;

        // Check if we're on a Coursera course page
        if (!tab.url || !tab.url.includes('coursera.org/learn')) {
            showToast('⚠️ Please navigate to a Coursera course page first.');
            return;
        }

        chrome.tabs.sendMessage(tab.id, { action }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[AutoCoursera Popup]', chrome.runtime.lastError.message);
                showToast('⚠️ Could not connect to page. Try reloading the Coursera tab.');
                return;
            }
            if (response?.ok === false) {
                showToast(response.error || 'The page could not start that action.');
                return;
            }
            window.close();
        });
    }

    // ─── Toast notification ───────────────────────────────────────────────────

    function showToast(message) {
        let toast = document.getElementById('ac-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ac-toast';
            toast.style.cssText = `
                position: fixed; bottom: 12px; left: 12px; right: 12px;
                background: #1e293b; color: #fde68a; border-radius: 8px;
                padding: 10px 14px; font-size: 12px; z-index: 9999;
                border: 1px solid #475569; animation: fadeIn 0.2s ease;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
    }

    // ─── Button handlers ──────────────────────────────────────────────────────

    if (bypassBtn) {
        bypassBtn.addEventListener('click', () => {
            sendToTab('bypass');
        });
    }

    if (autoQuizBtn) {
        autoQuizBtn.addEventListener('click', async () => {
            const tab = await getActiveTab();
            if (!tab || !tab.url || !tab.url.includes('coursera.org/learn')) {
                showToast('⚠️ Please navigate to a Coursera quiz page first.');
                return;
            }
            // Check API key
            const apiKey = keyInput.value.trim();
            if (!apiKey) {
                showToast('⚠️ Please enter your Gemini API key first.');
                keyInput.focus();
                return;
            }
            // Save key first
            chrome.storage.local.set({ apiKey, model: modelSelect.value, quizEnabled: quizToggle.checked }, () => {
                sendToTab('autoQuiz');
            });
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveSettings);
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const apiKey = keyInput.value.trim();
            fetchAvailableModels(apiKey, true);
        });
    }

    if (keyInput) {
        keyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveSettings();
        });
        keyInput.addEventListener('change', () => {
            const apiKey = keyInput.value.trim();
            if (apiKey) {
                fetchAvailableModels(apiKey, false);
            }
        });
    }

    if (quizToggle) {
        quizToggle.addEventListener('change', () => {
            chrome.storage.local.set({ quizEnabled: quizToggle.checked });
        });
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadSettings, { once: true });
    else loadSettings();

})();