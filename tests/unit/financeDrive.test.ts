import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFinanceReportToDrive, type GoogleDriveIdentity } from '../../src/modules/finance/financeDrive';

const signal = () => new AbortController().signal;
const file = () => Promise.resolve(new File(['test XLSX content'], 'OPiU.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));

afterEach(() => vi.unstubAllGlobals());

describe('save a report in the selected Google Drive', () => {
  it('requests file-only consent and uploads the workbook from the browser', async () => {
    const fetchUpload = vi.fn().mockResolvedValue(Response.json({ id: 'private_file-1' }));
    vi.stubGlobal('fetch', fetchUpload);
    const identity: GoogleDriveIdentity = {
      initTokenClient(options) {
        expect(options.client_id).toBe('public-client');
        expect(options.scope).toBe('https://www.googleapis.com/auth/drive.file');
        expect(options.include_granted_scopes).toBe(false);
        return { requestAccessToken: ({ prompt }) => {
          expect(prompt).toBe('select_account');
          options.callback({ access_token: 'short-lived-test-token', scope: options.scope });
        } };
      },
    };
    const link = await saveFinanceReportToDrive(identity, 'public-client', file, signal());
    const [url, options] = fetchUpload.mock.calls[0];
    expect(new URL(url).pathname).toBe('/upload/drive/v3/files');
    expect(new URL(url).searchParams.get('uploadType')).toBe('multipart');
    expect(options.headers.Authorization).toBe('Bearer short-lived-test-token');
    expect(options.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(await options.body.text()).toContain('"name":"OPiU.xlsx"');
    expect(await options.body.text()).toContain('test XLSX content');
    expect(link).toBe('https://drive.google.com/open?id=private_file-1');
  });

  it('does not make a workbook or upload it if Google Drive consent was denied', async () => {
    const fetchUpload = vi.fn();
    const makeFile = vi.fn(file);
    vi.stubGlobal('fetch', fetchUpload);
    const identity: GoogleDriveIdentity = {
      initTokenClient: ({ callback }) => ({ requestAccessToken: () => callback({ error: 'access_denied' }) }),
    };
    await expect(saveFinanceReportToDrive(identity, 'public-client', makeFile, signal())).rejects.toThrow();
    expect(makeFile).not.toHaveBeenCalled();
    expect(fetchUpload).not.toHaveBeenCalled();
  });

  it('discards a late consent callback after leaving the report', async () => {
    const fetchUpload = vi.fn();
    const makeFile = vi.fn(file);
    vi.stubGlobal('fetch', fetchUpload);
    const controller = new AbortController();
    const identity: GoogleDriveIdentity = {
      initTokenClient: ({ callback, scope }) => ({ requestAccessToken: () => {
        controller.abort();
        callback({ access_token: 'late-test-token', scope });
      } }),
    };
    await expect(saveFinanceReportToDrive(identity, 'public-client', makeFile, controller.signal)).rejects.toThrow();
    expect(makeFile).not.toHaveBeenCalled();
    expect(fetchUpload).not.toHaveBeenCalled();
  });
});
