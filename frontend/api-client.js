window.DCPCAFrontend = window.DCPCAFrontend || {};

window.DCPCAFrontend.appDataRequest = (payload) => {
    return fetch('/api/app-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    });
};
