import { describe, expect, it } from 'vitest';
import { FileGrants, extensionOf, mimeFor, isTextual, readThroughConnection } from '../src/fileGrants.js';

describe('file grants', () => {
  it('stands for one file, not a folder, and expires', async () => {
    const grants = new FileGrants({ ttlMs: 30 });
    const issued = grants.issue({ connection: 'files', filePath: '/Users/phil/notes/report.pdf' });
    expect(issued).toMatchObject({ name: 'report.pdf', ext: 'pdf', mime: 'application/pdf' });
    // The viewer receives an opaque id; the path never leaves the host.
    expect(issued.id).not.toContain('report');
    expect(grants.get(issued.id).filePath).toBe('/Users/phil/notes/report.pdf');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(() => grants.get(issued.id)).toThrow(/expired/);
  });

  it('refuses an id it never issued', () => {
    expect(() => new FileGrants().get('made-up')).toThrow(/expired/);
  });

  it('types files by extension', () => {
    expect(extensionOf('/a/B/Thing.MD')).toBe('md');
    expect(mimeFor('x.png')).toBe('image/png');
    expect(mimeFor('x.unknownext')).toBe('application/octet-stream');
    expect(isTextual('notes.md')).toBe(true);
    expect(isTextual('scan.pdf')).toBe(false);
  });
});

describe('reading through a connection', () => {
  const connection = (tools, replies) => ({
    tools: tools.map((name) => ({ name })),
    async start() {},
    async call(tool, args) { return replies[tool](args); },
  });

  it('prefers a media read for binary and returns its bytes', async () => {
    const bytes = await readThroughConnection(
      connection(['read_file', 'read_media_file'], { read_media_file: () => ({ raw: [{ data: Buffer.from('PNGDATA').toString('base64') }] }) }),
      '/a/pic.png',
    );
    expect(bytes.toString()).toBe('PNGDATA');
  });

  it('prefers a text read for text, and falls back to whatever exists', async () => {
    const text = await readThroughConnection(
      connection(['read_file', 'read_text_file'], { read_text_file: () => ({ text: '# Title' }) }),
      '/a/notes.md',
    );
    expect(text.toString()).toBe('# Title');

    const only = await readThroughConnection(
      connection(['read_file'], { read_file: () => ({ text: 'plain' }) }),
      '/a/notes.md',
    );
    expect(only.toString()).toBe('plain');
  });

  it('says so when a connection cannot read files at all', async () => {
    await expect(readThroughConnection(connection(['list_directory'], {}), '/a/x.txt')).rejects.toThrow(/cannot read files/);
  });
});
