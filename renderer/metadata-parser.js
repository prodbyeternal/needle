/**
 * NEEDLE — ID3 METADATA PARSER & COVER ART ENGINE
 * Fully client-side, zero-dependency binary ID3v2 reader,
 * combined with iTunes Search API integrations and procedural geometric artwork fallbacks.
 */

export async function parseMetadata(file) {
  const fileTitle = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
  const result = {
    title: fileTitle,
    artist: 'UNKNOWN ARTIST',
    album: 'UNKNOWN ALBUM',
    coverUrl: null,
    bpm: null,
    bpmSource: null,
    key: null,
    keySource: null,
    isProcedural: false
  };

  try {
    const buffer = await file.slice(0, 10 * 1024 * 1024).arrayBuffer(); // Slice first 10MB (ID3 tags are at the start)
    const view = new DataView(buffer);

    // Verify ID3 Identifier: "ID3" (0x49, 0x44, 0x33)
    if (view.byteLength >= 10 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
      const majorVersion = view.getUint8(3);
      const tagSize = readSynchsafeInt(view, 6);
      
      let offset = 10;
      const endOffset = Math.min(offset + tagSize, view.byteLength);

      while (offset < endOffset - 10) {
        // Read Frame ID (4 bytes)
        let frameId = '';
        for (let i = 0; i < 4; i++) {
          const charCode = view.getUint8(offset + i);
          if (charCode >= 32 && charCode <= 126) {
            frameId += String.fromCharCode(charCode);
          }
        }

        // If frameId is empty or contains non-alphanumeric, break (padding bytes reached)
        if (!/^[A-Z0-9]{4}$/.test(frameId)) {
          break;
        }

        // Read Frame Size (4 bytes)
        // ID3v2.3 uses standard 32-bit int, ID3v2.4 uses synchsafe. We support both by checking major version.
        const frameSize = majorVersion === 4 ? readSynchsafeInt(view, offset + 4) : view.getUint32(offset + 4);
        const nextFrameOffset = offset + 10 + frameSize;
        if (nextFrameOffset > endOffset) break;

        const frameDataOffset = offset + 10;

        if (frameId === 'TIT2') {
          result.title = decodeTextFrame(view, frameDataOffset, frameSize);
        } else if (frameId === 'TPE1') {
          result.artist = decodeTextFrame(view, frameDataOffset, frameSize);
        } else if (frameId === 'TALB') {
          result.album = decodeTextFrame(view, frameDataOffset, frameSize);
        } else if (frameId === 'TBPM') {
          const parsedBpm = parseBpmValue(decodeTextFrame(view, frameDataOffset, frameSize));
          if (parsedBpm) {
            result.bpm = parsedBpm;
            result.bpmSource = 'ID3';
          }
        } else if (frameId === 'TKEY') {
          const parsedKey = parseKeyValue(decodeTextFrame(view, frameDataOffset, frameSize));
          if (parsedKey) {
            result.key = parsedKey;
            result.keySource = 'ID3';
          }
        } else if (frameId === 'APIC') {
          const coverBlob = parseAPICFrame(view, frameDataOffset, frameSize);
          if (coverBlob) {
            result.coverUrl = URL.createObjectURL(coverBlob);
            result.coverBlob = coverBlob;
          }
        }

        offset = nextFrameOffset;
      }
    }
  } catch (error) {
    console.warn("ID3 parser warning (using filename fallback):", error);
  }

  if (result.artist === 'UNKNOWN ARTIST' && fileTitle.includes(' - ')) {
    const [artist, ...titleParts] = fileTitle.split(' - ');
    const title = titleParts.join(' - ');
    if (artist && title) {
      result.artist = artist.trim();
      result.title = title.trim();
    }
  }

  // If no local cover art was extracted, query iTunes Search API over the network
  if (!result.coverUrl && result.title) {
    try {
      const artUrl = await fetchCoverFromInternet(result.artist, result.title);
      if (artUrl) {
        result.coverUrl = artUrl;
      }
    } catch (e) {
      console.warn("Internet cover art fetch failed:", e);
    }
  }

  // If still no cover art, generate procedural art
  if (!result.coverUrl) {
    result.coverUrl = generateProceduralArtwork(result.title, result.artist);
    result.isProcedural = true;
  }

  return result;
}

function parseBpmValue(value) {
  const bpm = Number.parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(bpm) && bpm >= 40 && bpm <= 240 ? bpm : null;
}

function parseKeyValue(value) {
  const key = String(value || '').trim();
  return key && key.length <= 8 ? key : null;
}

/**
 * Reads synchsafe integer (7 bits per byte instead of 8, MSB is always 0)
 */
function readSynchsafeInt(view, offset) {
  const b1 = view.getUint8(offset);
  const b2 = view.getUint8(offset + 1);
  const b3 = view.getUint8(offset + 2);
  const b4 = view.getUint8(offset + 3);
  return (b1 << 21) | (b2 << 14) | (b3 << 7) | b4;
}

/**
 * Decodes the text frame content based on text encoding prefix
 */
function decodeTextFrame(view, offset, size) {
  if (size <= 1) return '';
  const encoding = view.getUint8(offset);
  const textBytes = new Uint8Array(view.buffer, view.byteOffset + offset + 1, size - 1);

  if (encoding === 0) {
    // ISO-8859-1 (ASCII / Latin1)
    let str = '';
    for (let i = 0; i < textBytes.length; i++) {
      if (textBytes[i] === 0) break; // Terminated by null
      str += String.fromCharCode(textBytes[i]);
    }
    return str.trim();
  } else if (encoding === 1 || encoding === 2) {
    // UTF-16 with BOM (1) or without BOM (2)
    // Simple UTF-16 decoder
    let str = '';
    let startIdx = 0;
    // Check BOM
    if (encoding === 1 && textBytes.length >= 2) {
      if (textBytes[0] === 0xFF && textBytes[1] === 0xFE) {
        // Little Endian
        for (let i = 2; i < textBytes.length - 1; i += 2) {
          const charCode = textBytes[i] | (textBytes[i + 1] << 8);
          if (charCode === 0) break;
          str += String.fromCharCode(charCode);
        }
        return str.trim();
      } else if (textBytes[0] === 0xFE && textBytes[1] === 0xFF) {
        // Big Endian
        for (let i = 2; i < textBytes.length - 1; i += 2) {
          const charCode = (textBytes[i] << 8) | textBytes[i + 1];
          if (charCode === 0) break;
          str += String.fromCharCode(charCode);
        }
        return str.trim();
      }
    }
    // Default fallback to reading UTF-16 bytes
    for (let i = startIdx; i < textBytes.length - 1; i += 2) {
      const charCode = (textBytes[i] << 8) | textBytes[i + 1];
      if (charCode === 0) break;
      str += String.fromCharCode(charCode);
    }
    return str.trim();
  } else if (encoding === 3) {
    // UTF-8
    try {
      const decoder = new TextDecoder('utf-8');
      const str = decoder.decode(textBytes);
      return str.replace(/\0/g, '').trim();
    } catch (e) {
      // Fallback
      return String.fromCharCode.apply(null, textBytes).replace(/\0/g, '').trim();
    }
  }

  return '';
}

/**
 * Decodes APIC Attached Picture Frame to Blob
 */
function parseAPICFrame(view, offset, size) {
  const startOffset = offset;
  const encoding = view.getUint8(offset);
  offset += 1;

  // Read MIME type
  let mimeType = '';
  while (offset < startOffset + size) {
    const b = view.getUint8(offset);
    offset++;
    if (b === 0) break;
    mimeType += String.fromCharCode(b);
  }
  if (!mimeType) mimeType = 'image/jpeg';

  // Picture type (1 byte)
  const picType = view.getUint8(offset);
  offset += 1;

  // Description
  if (encoding === 0 || encoding === 3) {
    // ASCII/UTF-8 terminated by 0x00
    while (offset < startOffset + size) {
      const b = view.getUint8(offset);
      offset++;
      if (b === 0) break;
    }
  } else {
    // UTF-16 terminated by 0x00 0x00
    while (offset < startOffset + size - 1) {
      const b1 = view.getUint8(offset);
      const b2 = view.getUint8(offset + 1);
      offset += 2;
      if (b1 === 0 && b2 === 0) break;
    }
  }

  // The remaining data is the image data
  const dataSize = (startOffset + size) - offset;
  if (dataSize <= 0) return null;

  const imgData = new Uint8Array(view.buffer, view.byteOffset + offset, dataSize);
  return new Blob([imgData], { type: mimeType });
}

/**
 * Fetches high-resolution album cover art from iTunes API in the background
 */
async function fetchCoverFromInternet(artist, title) {
  const searchTerm = artist && artist !== 'UNKNOWN ARTIST' ? `${artist} ${title}` : title;
  const searchQuery = encodeURIComponent(searchTerm);
  const url = `https://itunes.apple.com/search?term=${searchQuery}&entity=musicTrack&limit=1`;

  const response = await fetch(url);
  if (!response.ok) throw new Error("Network response error");

  const data = await response.json();
  if (data.results && data.results.length > 0) {
    const track = data.results[0];
    let artworkUrl = track.artworkUrl100;
    if (artworkUrl) {
      // iTunes URLs end in something like ".../100x100bb.jpg".
      // We can easily replace the dimensions to get the ultra high-resolution source (600x600px)!
      artworkUrl = artworkUrl.replace('100x100bb.jpg', '600x600bb.jpg');
      return artworkUrl;
    }
  }
  return null;
}

/**
 * Generates beautiful Scandinavian abstract geometric poster art as a procedural Canvas label
 */
function generateProceduralArtwork(title, artist) {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');

  // Simple string hashing
  let hash = 0;
  const str = (title + artist).toUpperCase();
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Pick deterministic palette based on hash values
  const hue1 = Math.abs(hash) % 360;
  const hue2 = (hue1 + 120) % 360;
  const darkTheme = (hash & 1) === 0;

  // Background
  if (darkTheme) {
    ctx.fillStyle = '#18181A';
  } else {
    ctx.fillStyle = '#F4F5F6';
  }
  ctx.fillRect(0, 0, 300, 300);

  // Geometric layout options
  const layout = Math.abs(hash >> 2) % 4;

  ctx.save();
  ctx.translate(150, 150);

  // Drawing elements
  if (layout === 0) {
    // Concentric brutalist layers
    ctx.strokeStyle = darkTheme ? `hsla(${hue1}, 70%, 60%, 0.3)` : `hsla(${hue1}, 60%, 40%, 0.2)`;
    ctx.lineWidth = 1;
    for (let r = 20; r <= 130; r += 15) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Colored wedge
    ctx.fillStyle = `hsla(${hue2}, 85%, 50%, 0.75)`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 110, 0, Math.PI * 0.45);
    ctx.closePath();
    ctx.fill();

    // Secondary ring dots
    ctx.fillStyle = darkTheme ? '#FFFFFF' : '#121212';
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 80, Math.sin(a) * 80, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (layout === 1) {
    // Bauhaus geometric intersection
    ctx.fillStyle = `hsla(${hue1}, 80%, 50%, 0.65)`;
    ctx.beginPath();
    ctx.arc(-30, -20, 65, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `hsla(${hue2}, 90%, 55%, 0.5)`;
    ctx.beginPath();
    ctx.arc(35, 20, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = darkTheme ? '#FFFFFF' : '#121212';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-100, 0);
    ctx.lineTo(100, 0);
    ctx.moveTo(0, -100);
    ctx.lineTo(0, 100);
    ctx.stroke();
  } else if (layout === 2) {
    // Dot Matrix radial array
    ctx.fillStyle = `hsla(${hue1}, 85%, 45%, 0.8)`;
    ctx.beginPath();
    ctx.arc(0, 0, 35, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = darkTheme ? 'rgba(255,255,255,0.15)' : 'rgba(18,18,18,0.1)';
    for (let r = 50; r <= 130; r += 20) {
      const dotsCount = Math.floor(r * 0.4);
      for (let i = 0; i < dotsCount; i++) {
        const angle = (i / dotsCount) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    // Grid array with random blocks
    ctx.strokeStyle = darkTheme ? 'rgba(255,255,255,0.08)' : 'rgba(18,18,18,0.06)';
    ctx.lineWidth = 1;
    // Draw fine grid
    for (let i = -120; i <= 120; i += 30) {
      ctx.beginPath();
      ctx.moveTo(i, -120); ctx.lineTo(i, 120);
      ctx.moveTo(-120, i); ctx.lineTo(120, i);
      ctx.stroke();
    }
    // High contrast brutalist bars
    ctx.fillStyle = `hsla(${hue1}, 85%, 50%, 0.8)`;
    ctx.fillRect(-60, -30, 120, 20);
    ctx.fillStyle = `hsla(${hue2}, 85%, 50%, 0.8)`;
    ctx.fillRect(-30, 20, 40, 50);

    ctx.fillStyle = darkTheme ? '#FFFFFF' : '#121212';
    ctx.beginPath();
    ctx.arc(30, 45, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw spindle center border ring
  ctx.strokeStyle = darkTheme ? '#FFFFFF' : '#121212';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.stroke();

  // Subtle textual border inside the label
  ctx.fillStyle = darkTheme ? 'rgba(255,255,255,0.4)' : 'rgba(18,18,18,0.4)';
  ctx.font = "bold 8px 'DM Mono'";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText("NEEDLE DEVICE", 0, -135);

  ctx.restore();

  return canvas.toDataURL('image/jpeg');
}
