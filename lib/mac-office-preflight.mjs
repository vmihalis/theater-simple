import {execFile} from 'node:child_process';

const unzip = '/usr/bin/unzip';
const externalMessage = 'This PowerPoint links to external media or data. Embed those items in PowerPoint, or save it as PDF and select that PDF here.';

function run(args, maxBuffer = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(unzip, args, {timeout: 30_000, maxBuffer, encoding: 'utf8'}, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function decodeXml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, entity => {
    const name = entity.slice(1, -1);
    const known = {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'};
    if (known[name.toLowerCase()]) return known[name.toLowerCase()];
    const codepoint = name[0] === '#' ? Number.parseInt(name[1]?.toLowerCase() === 'x' ? name.slice(2) : name.slice(1), name[1]?.toLowerCase() === 'x' ? 16 : 10) : NaN;
    return Number.isFinite(codepoint) && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : entity;
  });
}

export function checkRelationships(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('This PowerPoint contains unsupported XML declarations. Save it as PDF and select that PDF here.');
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*>/gi)) {
    const attributes = {};
    for (const attribute of match[0].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) attributes[attribute[1]] = decodeXml(attribute[3]);
    const mode = attributes.TargetMode || '';
    const type = attributes.Type || '';
    const target = attributes.Target || '';
    if ((/^External$/i.test(mode) || /^[a-z][a-z\d+.-]*:|^\\\\|^\/\//i.test(target)) && !/\/hyperlink$/i.test(type)) throw new Error(externalMessage);
  }
}

export async function preflightMacPowerPoint(filename, runCommand = run) {
  let entries;
  try { entries = (await runCommand(['-Z', '-1', filename], 2 * 1024 * 1024)).split(/\r?\n/).filter(Boolean); }
  catch { throw new Error('This PowerPoint file could not be inspected. Save it as a new .pptx or PDF and select that copy.'); }
  if (entries.length > 15_000 || !entries.includes('ppt/presentation.xml')) throw new Error('This file is not a valid modern PowerPoint presentation.');
  let relationshipBytes = 0;
  for (const entry of entries) {
    if (/(^|\/)(?:vbaProject\.bin|activeX)(?:\/|$)/i.test(entry)) throw new Error('This presentation contains macros or active controls. Export it as PDF and select that PDF here.');
    if (!entry.endsWith('.rels')) continue;
    if (!/^[A-Za-z0-9_.\/-]+$/.test(entry) || entry.includes('..')) throw new Error('This PowerPoint contains an invalid relationship path.');
    let xml;
    try { xml = await runCommand(['-p', filename, entry], 4 * 1024 * 1024); }
    catch { throw new Error('This PowerPoint relationship data could not be inspected. Save it as PDF and select that PDF here.'); }
    relationshipBytes += Buffer.byteLength(xml);
    if (relationshipBytes > 16 * 1024 * 1024) throw new Error('This PowerPoint has too much relationship data. Save it as PDF and select that PDF here.');
    checkRelationships(xml);
  }
}
