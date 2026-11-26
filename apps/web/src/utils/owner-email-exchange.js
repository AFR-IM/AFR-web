(() => {
  const page = document.querySelector('[data-owner-email-exchange]');
  if (!page) return;

  const button = page.querySelector('[data-redeem]');
  const status = page.querySelector('[data-status]');
  const heading = page.querySelector('[data-heading]');
  const intro = page.querySelector('[data-intro]');
  const result = page.querySelector('[data-result]');
  const domainText = page.querySelector('[data-domain]');
  const ownerLink = page.querySelector('[data-owner-link]');
  const copyFallback = page.querySelector('[data-copy-fallback]');
  const manageInput = page.querySelector('[data-manage-token]');
  const copy = page.querySelector('[data-copy]');
  const copyStatus = page.querySelector('[data-copy-status]');
  const messages = page.dataset;
  const endpoint = messages.action === 'recover'
    ? '/api/v1/owners/email/recover/verify'
    : '/api/v1/owners/email/verify';

  const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
  let token = /^#token=([0-9a-f]{32})$/.exec(location.hash)?.[1];
  if (location.hash || location.search) history.replaceState(null, '', location.pathname);
  if (!token) {
    intro.hidden = true;
    status.textContent = messages.invalid;
    return;
  }

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(manageInput.value);
      copyStatus.textContent = messages.copied;
    } catch {
      manageInput.focus();
      manageInput.select();
      copyStatus.textContent = messages.copyManually;
    }
  });

  button.addEventListener('click', async (event) => {
    if (!event.isTrusted || !token || button.disabled) return;
    button.disabled = true;
    status.textContent = messages.working;
    try {
      // Keep the one-time token out of URLs, including API request logs.
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'omit',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (response.status === 429) {
        status.textContent = messages.rateLimited;
        return;
      }
      const body = await response.json();
      if (response.status === 400 && body?.error === 'invalid_or_expired_token') {
        token = undefined;
        button.hidden = true;
        intro.hidden = true;
        status.textContent = messages.invalid;
        heading.focus();
        return;
      }
      const { verified, domain, manageToken } = body ?? {};
      if (!response.ok || verified !== true || typeof domain !== 'string' ||
          domain.length > 253 || !domainPattern.test(domain) ||
          typeof manageToken !== 'string' || !/^manage-[0-9a-f]{32}$/.test(manageToken)) {
        status.textContent = messages.failed;
        return;
      }

      token = undefined;
      try {
        localStorage.setItem(`afr-owner-mail-${domain}`, manageToken);
        status.textContent = messages.saved;
      } catch {
        manageInput.value = manageToken;
        copyFallback.hidden = false;
        status.textContent = messages.storageUnavailable;
      }
      domainText.textContent = domain;
      result.hidden = false;
      ownerLink.href = `${messages.ownerPath}${domain}/#owner-mailbox-title`;
      ownerLink.hidden = false;
      button.hidden = true;
      intro.hidden = true;
      heading.focus();
    } catch {
      status.textContent = messages.failed;
    } finally {
      button.disabled = false;
    }
  });
  button.hidden = false;
})();
