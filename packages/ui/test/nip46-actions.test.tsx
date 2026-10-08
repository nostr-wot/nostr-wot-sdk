import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Nip46Signer } from '@nostr-wot/signers';
import { Nip46Method } from '../src/login/methods/Nip46Method';
import { LoginModal } from '../src/login/LoginModal';
import { NostrSessionProvider } from '../src/session-shell';
import type { Nip46ConnectionOptions } from '../src/login/methods/Nip46ConnectionActions';

vi.mock('qrcode', () => ({ default: { toString: vi.fn().mockResolvedValue('<div>QR</div>') } }));
const labels = { openSigner: 'Abrir firmante', pasteUri: 'Usar URI', copyUri: 'Copiar URI', copied: 'Copiado', copyFailed: 'No se pudo copiar', fallbackHint: 'Pega la URI en el firmante' };

function Signer({ generation = 0, options }: { generation?: number; options?: Nip46ConnectionOptions }) {
  return <Nip46Method key={generation} inline connectionOptions={options} onAttached={vi.fn()} onError={vi.fn()} />;
}

beforeEach(() => {
  let generation = 0;
  vi.spyOn(Nip46Signer, 'startNostrConnect').mockImplementation(() => {
    let reject!: (reason: Error) => void;
    return {
      uri: `nostrconnect://pairing-${++generation}`,
      ready: new Promise((_, fail) => { reject = fail; }),
      cancel: () => reject(new Error('cancelled')),
    } as ReturnType<typeof Nip46Signer.startNostrConnect>;
  });
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android 15');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('native NIP-46 connection actions', () => {
  it('forwards connection options through the modal and widget', async () => {
    render(<NostrSessionProvider autoRestore={false}><LoginModal open onClose={vi.fn()} methods={['nip46']} nip46Connection={{ labels }} /></NostrSessionProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Remote signer/ }));
    expect(await screen.findByRole('link', { name: labels.openSigner })).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: labels.pasteUri })).toBeDefined();
  });

  it('renders one platform-customized link and copies the original current pairing URI', async () => {
    const copyUri = vi.fn().mockResolvedValue(true);
    const signerHref = vi.fn((uri: string, userAgent: string) => userAgent.includes('Android') ? uri.replace('nostrconnect:', 'intent:') : uri);
    const options = { labels, signerHref, copyUri, copyOnOpen: true };
    const { rerender } = render(<Signer options={options} />);
    const link = await screen.findByRole('link', { name: labels.openSigner });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(link.getAttribute('href')).toBe('intent://pairing-1');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(copyUri).toHaveBeenLastCalledWith('nostrconnect://pairing-1'));
    await screen.findByRole('button', { name: labels.copied });
    rerender(<Signer generation={1} options={options} />);
    const copy = await screen.findByRole('button', { name: labels.copyUri });
    fireEvent.click(copy);
    await waitFor(() => expect(copyUri).toHaveBeenLastCalledWith('nostrconnect://pairing-2'));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link').getAttribute('href')).toBe('intent://pairing-2');
  });

  it('updates translated labels natively and removes QR actions in paste mode', async () => {
    const { rerender } = render(<Signer options={{ labels }} />);
    await screen.findByRole('link', { name: labels.openSigner });
    expect(screen.getByRole('tab', { name: labels.pasteUri })).toBeDefined();
    rerender(<Signer options={{ labels: { ...labels, openSigner: 'Open signer', pasteUri: 'Use URI' } }} />);
    expect(screen.getByRole('link', { name: 'Open signer' })).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Use URI' }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: labels.copyUri })).toBeNull();
  });

  it.each([false, 'throw'])('reports clipboard failure without an unhandled rejection (%s)', async (outcome) => {
    const copyUri = vi.fn(async () => { if (outcome === 'throw') throw new Error('denied'); return false; });
    render(<Signer options={{ labels, copyUri }} />);
    fireEvent.click(await screen.findByRole('button', { name: labels.copyUri }));
    expect(await screen.findByRole('button', { name: labels.copyFailed })).toBeDefined();
  });

  it('reports unavailable default clipboard and keeps the standard signer URL', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<Signer />);
    const link = await screen.findByRole('link', { name: 'Open in signer app' });
    expect(link.getAttribute('href')).toBe('nostrconnect://pairing-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy connect URI' }));
    expect(await screen.findByRole('button', { name: 'Could not copy' })).toBeDefined();
  });
});
