/**
 * Auto Coursera v2.2.1 - page-world observer.
 *
 * Coursera is a single-page app. This observer exposes only non-secret course
 * context already present in the page's own API traffic. Authentication headers
 * are deliberately not copied into page messages.
 */
(function () {
    'use strict';

    const state = {
        courseId: null,
        userId: null,
        slug: null,
        items: [],
    };

    function broadcast(type, payload) {
        window.postMessage({ source: 'AUTOCOURSERA_INTERCEPTOR', type, payload }, '*');
    }

    function validIdentifier(value) {
        const text = value === undefined || value === null ? '' : String(value);
        return /^[A-Za-z0-9_-]{2,80}$/.test(text) ? text : null;
    }

    function readSlug() {
        return window.location.pathname.match(/\/learn\/([^/?#]+)/i)?.[1] || null;
    }

    function updateSlug() {
        const slug = readSlug();
        if (!slug || slug === state.slug) return;
        if (state.slug) {
            state.courseId = null;
            state.items = [];
        }
        state.slug = slug;
        broadcast('SLUG', { slug });
    }

    function setCourseId(value) {
        const courseId = validIdentifier(value);
        if (!courseId || courseId === state.courseId) return;
        state.courseId = courseId;
        broadcast('COURSE_ID', { courseId });
    }

    function setUserId(value) {
        const userId = value === undefined || value === null ? '' : String(value);
        if (!/^\d+$/.test(userId) || userId === state.userId) return;
        state.userId = userId;
        broadcast('USER_ID', { userId });
    }

    function getRequestUrl(resource) {
        if (typeof resource === 'string') return resource;
        if (resource instanceof URL) return resource.href;
        return resource?.url || '';
    }

    function isCourseraApiUrl(rawUrl) {
        if (!rawUrl || !String(rawUrl).includes('/api/')) return false;
        try {
            return new URL(rawUrl, window.location.origin).hostname.endsWith('coursera.org');
        } catch (_) {
            return false;
        }
    }

    function extractCourseIdFromUrl(rawUrl) {
        try {
            const url = new URL(rawUrl, window.location.origin);
            const queryId = validIdentifier(url.searchParams.get('courseId'));
            if (queryId) return queryId;

            let match = url.pathname.match(/\/onDemandLectureVideos\.v\d+\/([^/~]+)~[^/]+/i);
            if (match) return validIdentifier(decodeURIComponent(match[1]));

            match = url.pathname.match(/\/onDemandVideoProgresses\.v\d+\/[^/~]+~([^/~]+)~[^/]+/i);
            if (match) return validIdentifier(decodeURIComponent(match[1]));
        } catch (_) { /* ignore malformed third-party URLs */ }
        return null;
    }

    function firstElement(data) {
        return Array.isArray(data?.elements) ? data.elements[0] : null;
    }

    function processResponseData(rawUrl, data) {
        if (!rawUrl || !data || typeof data !== 'object') return;
        const url = String(rawUrl);
        const first = firstElement(data);

        const urlCourseId = extractCourseIdFromUrl(url);
        if (urlCourseId) setCourseId(urlCourseId);

        if (/onDemandCourseMaterials\.v\d+/i.test(url)) {
            if (first?.id) setCourseId(first.id);
            const linked = data.linked || {};
            const items = linked['onDemandCourseMaterialItems.v2'] || linked['onDemandCourseMaterialItems.v1'];
            if (Array.isArray(items)) {
                state.items = items;
                broadcast('COURSE_ITEMS', { items });
            }
        }

        if (/\/(?:onDemandCourses|courses)\.v\d+/i.test(url) && first?.id) setCourseId(first.id);

        if (/\/users\.v\d+/i.test(url) && first?.id !== undefined) setUserId(first.id);

        if (/onDemandCourseLearners/i.test(url) && first) {
            if (first.courseId) setCourseId(first.courseId);
            if (first.userId !== undefined) setUserId(first.userId);
        }

        if (data.courseId) setCourseId(data.courseId);
        if (data.userId !== undefined) setUserId(data.userId);
    }

    const originalFetch = window.fetch;
    window.fetch = async function (resource, options) {
        const url = getRequestUrl(resource);
        const response = await originalFetch.call(this, resource, options);
        if (isCourseraApiUrl(url)) {
            response.clone().json().then(data => processResponseData(url, data)).catch(() => {});
        }
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__autoCourseraUrl = String(url || '');
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        const url = this.__autoCourseraUrl || '';
        if (isCourseraApiUrl(url)) {
            this.addEventListener('load', function () {
                try {
                    const contentType = this.getResponseHeader('content-type') || '';
                    if (!contentType.includes('json') && typeof this.responseText !== 'string') return;
                    processResponseData(url, JSON.parse(this.responseText));
                } catch (_) { /* non-JSON or non-text response */ }
            }, { once: true });
        }
        return originalSend.apply(this, arguments);
    };

    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.source !== 'AUTOCOURSERA_CONTENT') return;
        if (event.data.type === 'GET_STATE') {
            updateSlug();
            broadcast('STATE', {
                courseId: state.courseId,
                userId: state.userId,
                slug: state.slug,
                items: state.items,
            });
        }
    });

    function onLocationChange() {
        updateSlug();
        broadcast('NAVIGATE', {
            url: window.location.href,
            pathname: window.location.pathname,
        });
    }

    for (const methodName of ['pushState', 'replaceState']) {
        const original = history[methodName];
        history[methodName] = function () {
            const result = original.apply(this, arguments);
            queueMicrotask(onLocationChange);
            return result;
        };
    }
    window.addEventListener('popstate', onLocationChange);
    updateSlug();
    console.log('[AutoCoursera] Page observer v2.2.1 loaded.');
})();
