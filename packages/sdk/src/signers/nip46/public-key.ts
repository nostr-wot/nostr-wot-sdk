/** Retry only the idempotent identity read: ephemeral relay requests can be lost. */
export function readPublicKeyWithRetry(request: () => Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let attempts = 0;
    let retry: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, pubkey?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(retry);
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancelled);
      if (error !== undefined) reject(error);
      else resolve(pubkey!);
    };
    const cancelled = () => finish(new Error('nostrconnect: cancelled'));
    const issue = () => {
      if (settled || attempts >= 3) return;
      attempts++;
      try {
        request().then((pubkey) => {
          if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
            finish(new Error('nostrconnect: invalid public key from signer'));
          } else finish(undefined, pubkey);
        }, (error) => finish(error ?? new Error('nostrconnect: public key request failed')));
      } catch (error) { finish(error ?? new Error('nostrconnect: public key request failed')); }
    };
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    retry = setInterval(issue, 3000);
    deadline = setTimeout(() => finish(new Error('nostrconnect: signer did not answer get_public_key within 120 seconds; please retry')), 120000);
    issue();
  });
}
