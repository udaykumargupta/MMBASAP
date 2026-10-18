import test from 'node:test';
import assert from 'node:assert/strict';
import { messageAad, newPairing, openJson, outgoingText, pairUrl, parsePairFragment, randomId, sealJson, smsLink, validPairing, whatsappLink } from '../public/js/pair.js';
import { qrSvg } from '../public/js/qr.js';

test('a new pairing has a 16-character room id and a 256-bit key', () => {
  const p = newPairing();
  assert.match(p.roomId, /^[A-Za-z0-9]{16}$/);
  assert.match(p.key, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(validPairing(p));
  assert.notDeepEqual(newPairing(), p);
  assert.match(randomId(10), /^[A-Za-z0-9]{10}$/);
});

test('the QR link carries the pairing in the #fragment, which browsers never send to the server', () => {
  const p = newPairing();
  const url = pairUrl('https://mmbasap.vercel.app/', p);
  assert.equal(url, `https://mmbasap.vercel.app/phone#r=${p.roomId}&k=${p.key}`);
  assert.deepEqual(parsePairFragment(new URL(url).hash), p);
  assert.equal(parsePairFragment('#r=short&k=x'), null);
  assert.equal(parsePairFragment(''), null);
});

test('messages round-trip; a wrong key or a changed byte is rejected', async () => {
  const p = newPairing();
  const value = { to: '+919876543210', text: 'नमस्ते 👋 & <b>hi</b>', files: [{ id: 'x', name: 'a.pdf' }] };
  const sealed = await sealJson(p.key, value);
  assert.match(sealed.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(await openJson(p.key, sealed), value);
  await assert.rejects(openJson(newPairing().key, sealed));
  const flipped = sealed.data[5] === 'A' ? 'B' : 'A';
  await assert.rejects(openJson(p.key, { iv: sealed.iv, data: sealed.data.slice(0, 5) + flipped + sealed.data.slice(6) }));
  assert.notEqual((await sealJson(p.key, value)).iv, sealed.iv, 'fresh IV every time');
});

test('a message is bound to its room and id: it can’t be replayed under another', async () => {
  const p = newPairing();
  const sealed = await sealJson(p.key, { text: 'pay 500' }, messageAad(p.roomId, 'Msg0000001'));
  assert.deepEqual(await openJson(p.key, sealed, messageAad(p.roomId, 'Msg0000001')), { text: 'pay 500' });
  await assert.rejects(openJson(p.key, sealed, messageAad(p.roomId, 'Msg0000002')));
  await assert.rejects(openJson(p.key, sealed, messageAad(newPairing().roomId, 'Msg0000001')));
});

test('blob storage treats the SDK’s “does not exist” error as a missing file', async () => {
  const { blobFiles } = await import('../lib/files.js');
  class BlobNotFoundError extends Error {}
  const files = blobFiles({ token: 't', sdk: async () => ({ BlobNotFoundError, head: async () => { throw new BlobNotFoundError('Vercel Blob: The requested blob does not exist'); } }) });
  assert.equal(await files.exists('mmbasap/AAAAAAAAAAAAAAAA/a.pdf'), false);
  const plain = blobFiles({ token: 't', sdk: async () => ({ head: async () => { throw new Error('Vercel Blob: The requested blob does not exist'); } }) });
  assert.equal(await plain.exists('mmbasap/AAAAAAAAAAAAAAAA/a.pdf'), false);
  const broken = blobFiles({ token: 't', sdk: async () => ({ head: async () => { throw new Error('network down'); } }) });
  await assert.rejects(broken.exists('mmbasap/AAAAAAAAAAAAAAAA/a.pdf'), /network down/);
});

test('blob upload URLs are signed for exactly the declared size', async () => {
  const { blobFiles } = await import('../lib/files.js');
  const seen = [];
  const sdk = async () => ({
    issueSignedToken: async (o) => { seen.push(['token', o.maximumSizeInBytes]); return { delegationToken: 'd', clientSigningToken: 'c' }; },
    presignUrl: async (_t, o) => { seen.push(['url', o.maximumSizeInBytes]); return { presignedUrl: 'https://blob.example/put' }; },
    parseStoreIdFromDelegationToken: () => 'store_1',
  });
  const target = await blobFiles({ token: 't', sdk }).uploadTarget({ fileId: 'mmbasap/AAAAAAAAAAAAAAAA/a.pdf', type: 'application/pdf', size: 1234 });
  assert.deepEqual(seen, [['token', 1234], ['url', 1234]]);
  assert.equal(target.headers['x-vercel-blob-store-id'], 'store_1');
});

test('WhatsApp click-to-chat and SMS links fill in number and text', () => {
  assert.equal(whatsappLink('+919876543210', 'hi there & bye'), 'https://wa.me/919876543210?text=hi%20there%20%26%20bye');
  assert.equal(whatsappLink('+919876543210', ''), 'https://wa.me/919876543210');
  assert.equal(smsLink('+919876543210', 'hi\nthere'), 'sms:+919876543210?body=hi%0Athere');
  assert.equal(smsLink('+919876543210', 'hi', { ios: true }), 'sms:+919876543210&body=hi');
  assert.equal(smsLink('+919876543210', ''), 'sms:+919876543210');
});

test('the download link is added only when files can’t go directly', () => {
  const m = { text: ' see this ', link: 'https://x/s/abc' };
  assert.equal(outgoingText(m, { includeLink: false }), 'see this');
  assert.equal(outgoingText(m, { includeLink: true }), 'see this\nhttps://x/s/abc');
  assert.equal(outgoingText({ text: '', link: 'https://x/s/abc' }, { includeLink: true }), 'https://x/s/abc');
});

test('the QR code is black on white SVG sized to the content', () => {
  const svg = qrSvg(pairUrl('https://mmbasap.vercel.app', newPairing()));
  assert.match(svg, /^<svg [^>]*viewBox="0 0 47 47"/); // version 6 (41 modules) + 3-module margin each side
  assert.match(svg, /<rect width="47" height="47" fill="#fff"\/>/);
  assert.ok((svg.match(/h1v1h-1z/g) || []).length > 500);
  assert.ok(!qrSvg('x', { label: '"><script>' }).includes('<script>'));
});
