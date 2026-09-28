// Custom ERP Interface Admin extension for the Data Manager.
(function() {
    if(window.location.pathname.toLowerCase() !== '/data') return;

    let style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/stylesheets/custom/erp-interface-admin.css';
    document.head.appendChild(style);

    let script = document.createElement('script');
    script.src = '/javascripts/custom/erp-interface-admin.js';
    script.async = false;
    document.head.appendChild(script);
})();
