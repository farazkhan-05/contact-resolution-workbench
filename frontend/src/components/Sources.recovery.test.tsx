import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sources } from './Sources';
import { api, ApiError, type Source } from '../api/client';

const auth = vi.hoisted(() => ({ status: 'ready', workspace: { id: 'recovery-workspace' } }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../api/client', async original => {
  const actual = await original<typeof import('../api/client')>();
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map(key => [key, vi.fn()])) };
});
const source = (id = 'one'): Source => ({ id, workspace_id: auth.workspace.id, name: `Source ${id}`, source_type: 'REFERENCE', status: 'ACTIVE', key_prefix: 'non-secret-prefix', last_ingested_at: null });
// Not a usable credential. No real key is generated, fetched or stored by tests.
const response = (id = 'one') => ({ ...source(id), api_key: '[non-secret display placeholder]' });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(owner = true) {
  const view = render(<Sources owner={owner} onReview={vi.fn()} />);
  await screen.findByRole('button', { name: 'View Source Source one' });
  await waitFor(() => expect(screen.queryByText('Loading ingestion history...')).toBeNull());
  return view;
}
function create(name = 'New feed') {
  fireEvent.change(screen.getByLabelText('Source name'), { target: { value: name } });
  fireEvent.submit(screen.getByLabelText('Source name').closest('form')!);
}
function select(id = 'one') { fireEvent.click(screen.getByRole('button', { name: `View Source Source ${id}` })); }
function rotate() { fireEvent.click(screen.getByRole('button', { name: 'Rotate API Key' })); }
const marker = () => sessionStorage.getItem(`crw.source-credential-unconfirmed:${auth.workspace.id}`);

beforeEach(() => {
  auth.status = 'ready'; auth.workspace = { id: `source-recovery-${crypto.randomUUID()}` };
  sessionStorage.clear();
  vi.mocked(api.listSources).mockResolvedValue([source('one'), source('two')]);
  vi.mocked(api.sourceHistory).mockResolvedValue([]);
  vi.mocked(api.createSource).mockResolvedValue(response('new'));
  vi.mocked(api.rotateSource).mockImplementation(async id => response(id));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('Source credential acknowledgement recovery', () => {
  it('confirmed creation preserves form arguments, shows the key once and refreshes only reads', async () => {
    await mount(); create('  New feed  ');
    const dialog = await screen.findByRole('dialog', { name: 'API key for Source new' });
    expect(api.createSource).toHaveBeenCalledExactlyOnceWith('New feed', 'REFERENCE');
    expect((screen.getByLabelText('Source name') as HTMLInputElement).value).toBe('');
    expect(within(dialog).getByText('Copy this key now. It cannot be shown again.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close and discard key' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close and discard key' }));
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(marker()).toBeNull();
    expect(api.rotateSource).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 422])('confirmed HTTP %s creation rejection preserves input and permits correction', async status => {
    vi.mocked(api.createSource).mockRejectedValueOnce(new ApiError(status, 'Synthetic rejected request'));
    await mount(); create(); await screen.findByText('Synthetic rejected request');
    expect(screen.queryByText('Source creation unconfirmed')).toBeNull(); expect(marker()).toBeNull();
    expect((screen.getByLabelText('Source name') as HTMLInputElement).value).toBe('New feed');
    create('Corrected feed'); await screen.findByRole('dialog', { name: 'API key for Source new' });
    expect(api.createSource).toHaveBeenCalledTimes(2); expect(window.confirm).not.toHaveBeenCalled();
  });
  it.each([new Error('Lost acknowledgement'), new ApiError(500, 'Server error'), new ApiError(503, 'Unavailable')])('creation uncertainty is retained after %s and refresh does not repeat writes', async error => {
    vi.mocked(api.createSource).mockRejectedValueOnce(error); await mount(); create();
    await screen.findByText('Source creation unconfirmed');
    expect(screen.getByText(/The Source might already exist/)).toBeTruthy();
    expect(screen.queryByText('Source operation failed.')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
    vi.mocked(api.listSources).mockResolvedValue([{ ...source('possible'), name: 'New feed' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Sources' }));
    await screen.findByRole('button', { name: 'View Source New feed' });
    expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
    expect(screen.getByText(/A matching name or an absent Source does not confirm/)).toBeTruthy();
    expect(api.createSource).toHaveBeenCalledTimes(1); expect(api.rotateSource).not.toHaveBeenCalled();
    expect(JSON.parse(marker()!)).toEqual(['create']);
  });
  it('an empty or failed Sources read does not reconcile an uncertain creation', async () => {
    vi.mocked(api.createSource).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); create();
    await screen.findByText('Source creation unconfirmed'); vi.mocked(api.listSources).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Sources' }));
    await screen.findByText('No Sources yet.'); expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
    vi.mocked(api.listSources).mockRejectedValueOnce(Error('Unavailable read'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Sources' }));
    await screen.findByText('Could not load Sources.'); expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
    expect(api.createSource).toHaveBeenCalledTimes(1);
  });
  it('uncertain creation requires informed confirmation for a new attempt and allows cancellation', async () => {
    vi.mocked(api.createSource).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); create();
    await screen.findByText('Source creation unconfirmed'); vi.mocked(window.confirm).mockReturnValueOnce(false); create();
    expect(api.createSource).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('This may create a duplicate Source'));
    create('Deliberate new feed'); await screen.findByRole('dialog', { name: 'API key for Source new' });
    expect(api.createSource).toHaveBeenNthCalledWith(2, 'Deliberate new feed', 'REFERENCE'); expect(marker()).toBeNull();
  });
  it('a rejected new attempt does not erase uncertainty about an earlier request', async () => {
    vi.mocked(api.createSource).mockRejectedValueOnce(Error('Lost acknowledgement')).mockRejectedValueOnce(new ApiError(422, 'New attempt rejected'));
    await mount(); create(); await screen.findByText('Source creation unconfirmed'); create();
    await screen.findByText('New attempt rejected'); expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
    expect(JSON.parse(marker()!)).toEqual(['create']);
  });
  it('storage failure keeps uncertain creation guarded across navigation without storing credentials', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Storage unavailable'); });
    vi.mocked(api.createSource).mockRejectedValueOnce(Error('Lost acknowledgement'));
    const view = await mount(); create(); await screen.findByText('Source creation unconfirmed'); view.unmount(); await mount();
    vi.mocked(window.confirm).mockReturnValueOnce(false); create(); expect(api.createSource).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
  });
  it('uncertain rotation does not block deliberate enabled/disabled controls or get erased by their readback', async () => {
    vi.mocked(api.rotateSource).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); select(); rotate();
    await screen.findByText('API key rotation unconfirmed: Source one');
    vi.mocked(api.sourceStatus).mockResolvedValueOnce({ ...source(), status: 'DISABLED' });
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await screen.findByText('Source status updated.'); expect(api.sourceStatus).toHaveBeenCalledExactlyOnceWith('one', 'DISABLED');
    expect(screen.getByText('API key rotation unconfirmed: Source one')).toBeTruthy(); expect(api.rotateSource).toHaveBeenCalledTimes(1);
  });
  it('prevents overlapping form submissions and blocks other writes until the response', async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.createSource).mockReturnValueOnce(pending.promise);
    await mount(); create(); create(); select();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' })); rotate();
    expect(api.createSource).toHaveBeenCalledTimes(1); expect(api.sourceStatus).not.toHaveBeenCalled(); expect(api.rotateSource).not.toHaveBeenCalled();
    expect(screen.getByText(/A Source credential request is in progress/)).toBeTruthy();
    await act(async () => pending.resolve(response('new'))); await screen.findByRole('dialog', { name: 'API key for Source new' });
  });
  it('confirmed rotation requires consent, displays once, and refresh cannot reconstruct its key', async () => {
    await mount(); select(); vi.mocked(window.confirm).mockReturnValueOnce(false); rotate(); expect(api.rotateSource).not.toHaveBeenCalled();
    rotate(); const dialog = await screen.findByRole('dialog', { name: 'API key for Source one' });
    expect(window.confirm).toHaveBeenCalledWith('Rotate the API key? The current key will stop working immediately.');
    expect(api.rotateSource).toHaveBeenCalledExactlyOnceWith('one'); expect(marker()).toBeNull();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(api.rotateSource).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('Lost acknowledgement'), new ApiError(500, 'Server error'), new ApiError(503, 'Unavailable')])('rotation uncertainty after %s warns about invalidation and cannot retrieve the key', async error => {
    vi.mocked(api.rotateSource).mockRejectedValueOnce(error); await mount(); select(); rotate();
    await screen.findByText('API key rotation unconfirmed: Source one');
    expect(screen.getByText(/previous key may already have been invalidated/)).toBeTruthy();
    expect(screen.getByText(/newly issued key cannot be displayed again/)).toBeTruthy();
    expect(screen.queryByText('Source operation failed.')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
    vi.mocked(api.listSources).mockResolvedValue([{ ...source('one'), key_prefix: 'changed-public-prefix' }, source('two')]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Sources' }));
    await screen.findByText('changed-public-prefix...');
    expect(screen.getByText(/changed key prefix does not confirm this particular rotation/)).toBeTruthy();
    expect(screen.getByText('API key rotation unconfirmed: Source one')).toBeTruthy(); expect(api.rotateSource).toHaveBeenCalledTimes(1);
    expect(JSON.parse(marker()!)).toEqual(['rotate:one']);
  });
  it('deliberate rotation recovery explicitly acknowledges current-key invalidation and permits cancellation', async () => {
    vi.mocked(api.rotateSource).mockRejectedValueOnce(Error('Lost acknowledgement')); await mount(); select(); rotate();
    await screen.findByText('API key rotation unconfirmed: Source one'); vi.mocked(window.confirm).mockReturnValueOnce(false); rotate();
    expect(api.rotateSource).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('This new rotation will invalidate the currently active key'));
    rotate(); await screen.findByRole('dialog', { name: 'API key for Source one' });
    expect(api.rotateSource).toHaveBeenCalledTimes(2); expect(marker()).toBeNull();
  });
  it.each([401, 403, 404, 422])('confirmed HTTP %s rotation rejection does not claim a key changed', async status => {
    vi.mocked(api.rotateSource).mockRejectedValueOnce(new ApiError(status, 'Rotation request rejected'));
    await mount(); select(); rotate(); await screen.findByText('Rotation request rejected');
    expect(screen.queryByText(/API key rotation unconfirmed/)).toBeNull(); expect(marker()).toBeNull();
  });
  it('source switching during a pending rotation keeps the response and uncertainty bound to the original Source', async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.rotateSource).mockReturnValueOnce(pending.promise);
    await mount(); select(); rotate(); select('two');
    await act(async () => pending.reject(Error('Lost acknowledgement')));
    expect(screen.getByRole('heading', { level: 3, name: 'Source two' })).toBeTruthy();
    expect(screen.getByText('API key rotation unconfirmed: Source one')).toBeTruthy();
    rotate(); await screen.findByRole('dialog', { name: 'API key for Source two' });
    expect(window.confirm).toHaveBeenLastCalledWith('Rotate the API key? The current key will stop working immediately.');
    expect(screen.getByText('API key rotation unconfirmed: Source one')).toBeTruthy();
  });
  it('late successful rotation after switching Sources displays only the original Source credential', async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.rotateSource).mockReturnValueOnce(pending.promise);
    await mount(); select(); rotate(); select('two'); await act(async () => pending.resolve(response('one')));
    expect(screen.getByRole('dialog', { name: 'API key for Source one' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Source two' })).toBeTruthy();
  });
  it.each(['success', 'failure'])('remount during a pending creation blocks repeats and discards late %s credentials', async outcome => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.createSource).mockReturnValueOnce(pending.promise);
    const view = await mount(); create(); view.unmount(); await mount(); create(); expect(api.createSource).toHaveBeenCalledTimes(1);
    await act(async () => { if (outcome === 'success') pending.resolve(response('new')); else pending.reject(Error('Lost acknowledgement')); });
    await screen.findByText('Source creation unconfirmed'); expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Source name') as HTMLInputElement).value).toBe('New feed');
  });
  it('workspace unmount prevents old responses from displaying a credential or affecting another workspace', async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.rotateSource).mockReturnValueOnce(pending.promise);
    const view = await mount(); select(); rotate(); const old = response('one'); view.unmount();
    auth.workspace = { id: 'another-source-workspace' }; vi.mocked(api.listSources).mockResolvedValue([source()]); await mount();
    await act(async () => pending.resolve(old)); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText(/unconfirmed/)).toBeNull();
    select(); rotate(); await screen.findByRole('dialog', { name: 'API key for Source one' });
  });
  it('owner access removal discards a pending response and leaves only read-only controls', async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.rotateSource).mockReturnValueOnce(pending.promise);
    const view = await mount(); select(); rotate(); view.rerender(<Sources owner={false} onReview={vi.fn()} />);
    await act(async () => pending.resolve(response())); expect(screen.queryByRole('dialog')).toBeNull();
    for (const name of ['Create Source', 'Rotate API Key', 'Disable', 'Enable']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
  it('reviewers cannot create or rotate and can still read Source history', async () => {
    await mount(false); select(); await screen.findByText('No ingestion history yet.');
    expect(screen.queryByLabelText('Source name')).toBeNull(); expect(screen.queryByRole('button', { name: 'Rotate API Key' })).toBeNull();
    expect(api.createSource).not.toHaveBeenCalled(); expect(api.rotateSource).not.toHaveBeenCalled();
  });
  it('a mismatched rotation response is unconfirmed and never displays another Source key', async () => {
    vi.mocked(api.rotateSource).mockResolvedValueOnce(response('two')); await mount(); select(); rotate();
    await screen.findByText('API key rotation unconfirmed: Source one'); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('restores persisted operation metadata without any key, name or request payload', async () => {
    sessionStorage.setItem(`crw.source-credential-unconfirmed:${auth.workspace.id}`, JSON.stringify(['create', 'rotate:one']));
    await mount(); expect(screen.getByText('Source creation unconfirmed')).toBeTruthy();
    expect(screen.getByText('API key rotation unconfirmed: Source one')).toBeTruthy(); expect(api.createSource).not.toHaveBeenCalled(); expect(api.rotateSource).not.toHaveBeenCalled();
  });
});
