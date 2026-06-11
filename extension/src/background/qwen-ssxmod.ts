// Local generation of qwen's ssxmod_itna / ssxmod_itna2 cookies, ported from
// the Qwen2API project (fingerprint.js + cookie-generator.js). Pure algorithm:
// a fixed device fingerprint template -> randomised hash fields + current
// timestamp -> LZW compression -> custom-base64 encode. No DOM, no network.
//
// Used only on the ssxmod fallback path (when no qwen tab is available to
// borrow a real baxia bx-ua from). On strict risk-control accounts this alone
// does NOT clear the WAF -- it's a best-effort last resort for lenient-IP users.

const CUSTOM_BASE64 = 'DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ';

// Apple M4 Mac default fingerprint template (37 caret-joined fields).
const TEMPLATE = {
  deviceId: '84985177a19a010dea49',
  sdkVersion: 'websdk-2.3.15d',
  initTimestamp: '1765348410850',
  field3: '91',
  field4: '1|15',
  language: 'zh-CN',
  timezoneOffset: '-480',
  colorDepth: '16705151|12791',
  screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
  field9: '5',
  platform: 'MacIntel',
  field11: '10',
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
  field13: '30|30',
  field14: '0',
  field15: '28',
  pluginCount: '5',
  vendor: 'Google Inc.',
  field29: '8',
  touchInfo: '-1|0|0|0|0',
  field32: '11',
  field35: '0',
  mode: 'P',
};

function randomHash(): number {
  return Math.floor(Math.random() * 4294967296);
}

function deviceId(): string {
  return Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// LZW compress + emit via charFunc, bit-packing into `bits`-wide symbols.
function lzwCompress(data: string, bits: number, charFunc: (i: number) => string): string {
  if (data == null) return '';
  const dict: Record<string, number> = {};
  const dictToCreate: Record<string, boolean> = {};
  let c = '', wc = '', w = '';
  let enlargeIn = 2, dictSize = 3, numBits = 2;
  const result: string[] = [];
  let value = 0, position = 0;

  const emitBit = (bit: number) => {
    value = (value << 1) | bit;
    if (position === bits - 1) { position = 0; result.push(charFunc(value)); value = 0; }
    else { position++; }
  };
  const emitChar = (w0: string) => {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w0)) {
      if (w0.charCodeAt(0) < 256) {
        for (let j = 0; j < numBits; j++) emitBit(0);
        let cc = w0.charCodeAt(0);
        for (let j = 0; j < 8; j++) { emitBit(cc & 1); cc >>= 1; }
      } else {
        for (let j = 0; j < numBits; j++) emitBit(j === 0 ? 1 : 0);
        let cc = w0.charCodeAt(0);
        for (let j = 0; j < 16; j++) { emitBit(cc & 1); cc >>= 1; }
      }
      enlargeIn--; if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
      delete dictToCreate[w0];
    } else {
      let cc = dict[w0];
      for (let j = 0; j < numBits; j++) { emitBit(cc & 1); cc >>= 1; }
    }
    enlargeIn--; if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  };

  for (let i = 0; i < data.length; i++) {
    c = data.charAt(i);
    if (!Object.prototype.hasOwnProperty.call(dict, c)) { dict[c] = dictSize++; dictToCreate[c] = true; }
    wc = w + c;
    if (Object.prototype.hasOwnProperty.call(dict, wc)) { w = wc; }
    else { emitChar(w); dict[wc] = dictSize++; w = String(c); }
  }
  if (w !== '') emitChar(w);

  // Flush marker (symbol 2) + trailing bits.
  let marker = 2;
  for (let j = 0; j < numBits; j++) { emitBit(marker & 1); marker >>= 1; }
  for (;;) {
    value = value << 1;
    if (position === bits - 1) { result.push(charFunc(value)); break; }
    position++;
  }
  return result.join('');
}

function customEncode(data: string): string {
  // urlSafe variant (no padding) -- matches the cookie format `1-<encoded>`.
  return lzwCompress(data, 6, i => CUSTOM_BASE64.charAt(i));
}

export function genSsxmod(): { ssxmod_itna: string; ssxmod_itna2: string } {
  const now = Date.now();
  const fields: (string | number)[] = [
    deviceId(),                                   // 0
    TEMPLATE.sdkVersion,                          // 1
    TEMPLATE.initTimestamp,                       // 2
    TEMPLATE.field3,                              // 3
    TEMPLATE.field4,                              // 4
    TEMPLATE.language,                            // 5
    TEMPLATE.timezoneOffset,                      // 6
    TEMPLATE.colorDepth,                          // 7
    TEMPLATE.screenInfo,                          // 8
    TEMPLATE.field9,                              // 9
    TEMPLATE.platform,                            // 10
    TEMPLATE.field11,                             // 11
    TEMPLATE.webglRenderer,                       // 12
    TEMPLATE.field13,                             // 13
    TEMPLATE.field14,                             // 14
    TEMPLATE.field15,                             // 15
    `${TEMPLATE.pluginCount}|${randomHash()}`,    // 16 (split: count|hash)
    randomHash(),                                 // 17
    randomHash(),                                 // 18
    '1', '0', '1', '0',                           // 19-22
    TEMPLATE.mode,                                // 23
    '0', '0', '0', '416',                         // 24-27
    TEMPLATE.vendor,                              // 28
    TEMPLATE.field29,                             // 29
    TEMPLATE.touchInfo,                           // 30
    randomHash(),                                 // 31
    TEMPLATE.field32,                             // 32
    now,                                          // 33 (current timestamp)
    randomHash(),                                 // 34
    TEMPLATE.field35,                             // 35
    Math.floor(Math.random() * 91) + 10,          // 36 (10-100)
  ];

  const itnaData = fields.join('^');
  const ssxmod_itna = '1-' + customEncode(itnaData);

  // itna2 uses only: field0, field1, field23, field32, field33 (+ P-mode blanks).
  const itna2Data = [
    fields[0], fields[1], fields[23],
    0, '', 0, '', '', 0, 0, 0,
    fields[32], fields[33],
    0, 0, 0, 0, 0,
  ].join('^');
  const ssxmod_itna2 = '1-' + customEncode(itna2Data);

  return { ssxmod_itna, ssxmod_itna2 };
}
