window.DCPCAFrontend = window.DCPCAFrontend || {};

window.DCPCAFrontend.appDataRequest = (payload) => {
    return fetch('/api/app-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    });
};

window.DCPCAFrontend.proxyFetch = async (endpoint, method = 'GET', body = null) => {
    try {
        const response = await fetch('/api/hello', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint, method, body })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data;
    } catch (error) {
        console.error('Proxy fetch error:', error);
        throw error;
    }
};
