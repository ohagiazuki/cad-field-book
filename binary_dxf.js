(function () {
  'use strict';

  const signature = 'AutoCAD Binary DXF\r\n\x1a\0';

  function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function isDouble(code) {
    return (code >= 10 && code <= 59) ||
      (code >= 110 && code <= 149) ||
      (code >= 210 && code <= 239) ||
      (code >= 460 && code <= 469) ||
      (code >= 1010 && code <= 1059);
  }

  function isInt16(code) {
    return (code >= 60 && code <= 79) ||
      (code >= 170 && code <= 179) ||
      (code >= 270 && code <= 279) ||
      (code >= 370 && code <= 389) ||
      (code >= 400 && code <= 409) ||
      (code >= 1060 && code <= 1070);
  }

  function isInt32(code) {
    return (code >= 90 && code <= 99) ||
      (code >= 420 && code <= 429) ||
      (code >= 440 && code <= 459) ||
      code === 1071;
  }

  function isInt64(code) {
    return code >= 160 && code <= 169;
  }

  function isByte(code) {
    return (code >= 280 && code <= 299);
  }

  function isBinaryChunk(code) {
    return (code >= 310 && code <= 319) || code === 1004;
  }

  function decodeBinaryDxf(bytes) {
    if (bytes.length < signature.length) {
      throw new Error('バイナリDXFのデータが途中で切れています。');
    }
    for (let index = 0; index < signature.length; index += 1) {
      if (bytes[index] !== signature.charCodeAt(index)) {
        throw new Error('AutoCADバイナリDXFではありません。');
      }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = signature.length;
    let decoder;
    try {
      decoder = new TextDecoder('shift_jis');
    } catch (_) {
      decoder = new TextDecoder('windows-1252');
    }
    const output = [];

    function requireBytes(count) {
      if (offset + count > bytes.length) {
        throw new Error('バイナリDXFのデータが途中で切れています。');
      }
    }

    function readString() {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
      if (offset >= bytes.length) {
        throw new Error('バイナリDXFの文字列終端が見つかりません。');
      }
      const value = decoder.decode(bytes.subarray(start, offset));
      offset += 1;
      return value;
    }

    while (offset < bytes.length) {
      requireBytes(2);
      const code = view.getUint16(offset, true);
      offset += 2;
      let value;

      if (isDouble(code)) {
        requireBytes(8);
        value = String(view.getFloat64(offset, true));
        offset += 8;
      } else if (isInt16(code)) {
        requireBytes(2);
        value = String(view.getInt16(offset, true));
        offset += 2;
      } else if (isInt32(code)) {
        requireBytes(4);
        value = String(view.getInt32(offset, true));
        offset += 4;
      } else if (isInt64(code)) {
        requireBytes(8);
        value = String(view.getBigInt64(offset, true));
        offset += 8;
      } else if (isByte(code)) {
        requireBytes(1);
        value = String(bytes[offset]);
        offset += 1;
      } else if (isBinaryChunk(code)) {
        requireBytes(1);
        const count = bytes[offset];
        offset += 1;
        requireBytes(count);
        value = Array.from(bytes.subarray(offset, offset + count), (byte) =>
          byte.toString(16).padStart(2, '0')).join('').toUpperCase();
        offset += count;
      } else {
        value = readString();
      }

      output.push(String(code), value);
      if (code === 0 && value === 'EOF') break;
    }

    return `${output.join('\n')}\n`;
  }

  globalThis.cadFieldbookDecodeBinaryDxfBase64 = function (base64) {
    return decodeBinaryDxf(fromBase64(base64));
  };
})();
