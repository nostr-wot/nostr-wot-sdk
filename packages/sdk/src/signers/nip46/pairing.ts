// A browser may lose its relay subscription while the external signer is open.
// Keep the same URI, client key and deadline across transient disconnects.
export async function waitForPairing<T>(listen: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let delay = 250;
  for (;;) {
    try {
      return await listen();
    } catch (error) {
      if (signal.aborted || !(error instanceof Error) ||
          !error.message.includes("subscription closed before connection was established")) throw error;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          clearTimeout(timer);
          reject(new Error("nostrconnect: pairing cancelled"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancelled);
          resolve();
        }, delay);
        signal.addEventListener("abort", cancelled, { once: true });
      });
      if (signal.aborted) throw new Error("nostrconnect: pairing cancelled");
      delay = Math.min(delay * 2, 2000);
    }
  }
}
