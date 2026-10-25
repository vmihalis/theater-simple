import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRelationships, preflightMacPowerPoint} from '../lib/mac-office-preflight.mjs';

const header = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const footer = '</Relationships>';
const relationship = (type, target, mode = '') => `<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" ${mode ? `TargetMode="${mode}"` : ''}/>`;

test('Mac preflight allows embedded media and ordinary click-only hyperlinks', () => {
  assert.doesNotThrow(() => checkRelationships(header + relationship('image', '../media/image1.gif') + relationship('hyperlink', 'https://example.com/', 'External') + footer));
});

test('Mac preflight rejects external media, including XML-escaped addresses', () => {
  for (const target of ['https://example.com/image.gif', 'file:///private/data.xlsx', '&#x68;ttps://example.com/video.mp4']) {
    assert.throws(() => checkRelationships(header + relationship('image', target, 'External') + footer), /links to external media or data/);
  }
  assert.throws(() => checkRelationships(header + relationship('video', 'https://example.com/clip.mp4') + footer), /links to external media or data/);
});

test('Mac preflight rejects XML entities before reading relationships', () => {
  assert.throws(() => checkRelationships('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private/data">]>' + header + footer), /unsupported XML declarations/);
});

test('Mac package scan refuses active controls and linked media before Office', async () => {
  const list = ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'];
  const run = async args => args[0] === '-Z' ? `${list.join('\n')}\n` : header + relationship('image', 'https://example.com/image.gif', 'External') + footer;
  await assert.rejects(preflightMacPowerPoint('/unused/deck.pptx', run), /links to external media or data/);
  const active = async args => args[0] === '-Z' ? `${list.join('\n')}\nppt/activeX/control1.bin\n` : header + footer;
  await assert.rejects(preflightMacPowerPoint('/unused/deck.pptx', active), /macros or active controls/);
});
