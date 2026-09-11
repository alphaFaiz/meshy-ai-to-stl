let modulePromise;

function signature(hostname, timestamp) {
  let hash = BigInt("14695981039346656037");
  const prime = BigInt("1099511628211");
  const mask = BigInt("0xFFFFFFFFFFFFFFFF");

  function mix(text) {
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
  }

  mix("Meshy_Crypto_Key");
  mix(`${hostname}:${timestamp}`);
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xff51afd7ed558ccd")) & mask;
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xc4ceb9fe1a85ec53")) & mask;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
}

async function getMeshyModule() {
  if (!modulePromise) {
    modulePromise = import("./vendor/mesh_loader.js").catch((error) => {
      throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
    }).then(({ default: Module }) => Module({
      locateFile: (path) => new URL(`./vendor/${path}`, location.href).href,
      printErr: () => {},
    })).catch((error) => {
      if (String(error.message || error).includes("mesh_loader.wasm")) {
        throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
      }
      throw error;
    }).then((mod) => {
      const hostname = "www.meshy.ai";
      const timestamp = Date.now();
      if (!mod.authorize(hostname, timestamp, signature(hostname, timestamp))) {
        throw new Error("Could not authorize the Meshy decoder.");
      }
      return mod;
    });
  }
  return modulePromise;
}

const readers = {
  5120: { size: 1, read: (b, o) => b.getInt8(o) },
  5121: { size: 1, read: (b, o) => b.getUint8(o) },
  5122: { size: 2, read: (b, o) => b.getInt16(o, true) },
  5123: { size: 2, read: (b, o) => b.getUint16(o, true) },
  5125: { size: 4, read: (b, o) => b.getUint32(o, true) },
  5126: { size: 4, read: (b, o) => b.getFloat32(o, true) },
};

const typeCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const textEncoder = new TextEncoder();

function readGlb(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== "glTF" || view.getUint32(4, true) !== 2) {
    throw new Error("The decoder did not return a valid GLB.");
  }

  let offset = 12;
  let json;
  let bin;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    const chunk = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "JSON") json = JSON.parse(new TextDecoder().decode(chunk));
    if (type === "BIN\0") bin = chunk;
    offset += 8 + length;
  }
  if (!json || !bin) throw new Error("GLB is missing JSON/BIN chunks.");
  return { json, bin };
}

function normalized(value, componentType) {
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  return value;
}

function accessorReader(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const bufferView = gltf.bufferViews[accessor.bufferView];
  const reader = readers[accessor.componentType];
  const itemSize = typeCounts[accessor.type];
  if (!reader || !itemSize) throw new Error(`Unsupported GLB accessor: ${index}`);

  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const stride = bufferView.byteStride || reader.size * itemSize;
  const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

  return {
    count: accessor.count,
    get(item) {
      const values = [];
      const base = start + item * stride;
      for (let i = 0; i < itemSize; i++) {
        let value = reader.read(view, base + i * reader.size);
        if (accessor.normalized) value = normalized(value, accessor.componentType);
        values.push(value);
      }
      return values;
    },
  };
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 4; k++) out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
    }
  }
  return out;
}

function matrixFromNode(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0];
  const s = node.scale || [1, 1, 1];
  const q = node.rotation || [0, 0, 0, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - yy - zz) * s[0], (xy - wz) * s[1], (xz + wy) * s[2], t[0],
    (xy + wz) * s[0], (1 - xx - zz) * s[1], (yz - wx) * s[2], t[1],
    (xz - wy) * s[0], (yz + wx) * s[1], (1 - xx - yy) * s[2], t[2],
    0, 0, 0, 1,
  ];
}

function transform(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function collectMeshNodes(gltf) {
  const scene = gltf.scenes[gltf.scene || 0];
  const nodes = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  function visit(index, parent) {
    const node = gltf.nodes[index];
    const world = multiply(parent, matrixFromNode(node));
    if (node.mesh !== undefined) nodes.push({ node, world });
    for (const child of node.children || []) visit(child, world);
  }

  for (const index of scene.nodes || []) visit(index, identity);
  return nodes;
}

function glbToBinaryStl(buffer) {
  const { json, bin } = readGlb(buffer);
  const meshNodes = collectMeshNodes(json);
  let triangleCount = 0;

  for (const { node } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      triangleCount += Math.floor((indices ? indices.count : positions.count) / 3);
    }
  }

  const out = new ArrayBuffer(84 + triangleCount * 50);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  bytes.set(new TextEncoder().encode("Converted from Meshy GLB"));
  view.setUint32(80, triangleCount, true);

  let offset = 84;
  function writeVector(v) {
    view.setFloat32(offset, v[0], true); offset += 4;
    view.setFloat32(offset, v[1], true); offset += 4;
    view.setFloat32(offset, v[2], true); offset += 4;
  }

  for (const { node, world } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const count = indices ? indices.count : positions.count;

      for (let i = 0; i + 2 < count; i += 3) {
        const ia = indices ? indices.get(i)[0] : i;
        const ib = indices ? indices.get(i + 1)[0] : i + 1;
        const ic = indices ? indices.get(i + 2)[0] : i + 2;
        const a = transform(world, positions.get(ia));
        const b = transform(world, positions.get(ib));
        const c = transform(world, positions.get(ic));
        writeVector(faceNormal(a, b, c));
        writeVector(a);
        writeVector(b);
        writeVector(c);
        view.setUint16(offset, 0, true);
        offset += 2;
      }
    }
  }

  return out;
}

function glbToObj(buffer) {
  const { json, bin } = readGlb(buffer);
  const meshNodes = collectMeshNodes(json);
  const lines = ["# Converted from Meshy GLB"];
  let vertexOffset = 0;
  let objectIndex = 0;

  for (const { node, world } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives || []).length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");

      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const objectName = String(mesh.name || node.name || `mesh_${objectIndex + 1}`)
        .replace(/[^a-z0-9_.-]+/gi, "_");
      lines.push(`o ${objectName}_${primitiveIndex + 1}`);

      for (let i = 0; i < positions.count; i++) {
        const point = transform(world, positions.get(i));
        lines.push(`v ${point[0]} ${point[1]} ${point[2]}`);
      }

      const count = indices ? indices.count : positions.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const a = (indices ? indices.get(i)[0] : i) + vertexOffset + 1;
        const b = (indices ? indices.get(i + 1)[0] : i + 1) + vertexOffset + 1;
        const c = (indices ? indices.get(i + 2)[0] : i + 2) + vertexOffset + 1;
        lines.push(`f ${a} ${b} ${c}`);
      }

      vertexOffset += positions.count;
      objectIndex++;
    }
  }

  if (!objectIndex) throw new Error("GLB does not contain triangle meshes.");
  return new TextEncoder().encode(`${lines.join("\n")}\n`).buffer;
}

function sanitizeName(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-z0-9_.-]+/gi, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || fallback;
}

function imageBytes(gltf, bin, imageIndex) {
  const image = gltf.images?.[imageIndex];
  if (!image) return null;

  if (image.bufferView !== undefined) {
    const bufferView = gltf.bufferViews[image.bufferView];
    const start = bufferView.byteOffset || 0;
    const end = start + bufferView.byteLength;
    return { bytes: bin.slice(start, end), mimeType: image.mimeType };
  }

  if (typeof image.uri === "string" && image.uri.startsWith("data:")) {
    const match = image.uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const payload = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) bytes[i] = payload.charCodeAt(i);
    return { bytes, mimeType };
  }

  return null;
}

function materialName(gltf, materialIndex) {
  if (materialIndex === undefined || !gltf.materials?.[materialIndex]) return "material_default";
  return `material_${materialIndex + 1}`;
}

async function bytesToPng(bytes, mimeType) {
  if (mimeType === "image/png") return bytes;

  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode PNG texture.")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

async function buildImageFiles(gltf, bin) {
  const imageFiles = new Map();

  for (let imageIndex = 0; imageIndex < (gltf.images || []).length; imageIndex++) {
    const image = gltf.images[imageIndex];
    const imageData = imageBytes(gltf, bin, imageIndex);
    if (!imageData) continue;

    const filename = `textures/${sanitizeName(image.name, `texture_${imageIndex + 1}`)}.png`;
    const bytes = await bytesToPng(imageData.bytes, imageData.mimeType);
    imageFiles.set(imageIndex, { filename, bytes });
  }

  return imageFiles;
}

async function buildTextureFiles(gltf, bin) {
  const textureFiles = new Map();
  const imageFiles = await buildImageFiles(gltf, bin);

  for (let textureIndex = 0; textureIndex < (gltf.textures || []).length; textureIndex++) {
    const texture = gltf.textures[textureIndex];
    const imageFile = imageFiles.get(texture.source);
    if (imageFile) textureFiles.set(textureIndex, imageFile);
  }

  if (!textureFiles.size) {
    let fallbackIndex = 0;
    for (const imageFile of imageFiles.values()) {
      textureFiles.set(fallbackIndex++, imageFile);
    }
  }

  return { textureFiles, imageFiles };
}

function materialTextureFile(textureFiles, textureInfo) {
  return textureInfo?.index === undefined ? null : textureFiles.get(textureInfo.index);
}

function appendMtlMaterial(lines, name, material, textureFiles, fallbackTextureFile) {
  const pbr = material?.pbrMetallicRoughness || {};
  const specGloss = material?.extensions?.KHR_materials_pbrSpecularGlossiness || {};
  const color = pbr.baseColorFactor || [1, 1, 1, 1];
  const roughness = pbr.roughnessFactor ?? 1;
  const metallic = pbr.metallicFactor ?? 0;
  const baseColorTexture = materialTextureFile(textureFiles, pbr.baseColorTexture)
    || materialTextureFile(textureFiles, specGloss.diffuseTexture)
    || (material ? null : fallbackTextureFile);
  const normalTexture = materialTextureFile(textureFiles, material?.normalTexture);
  const occlusionTexture = materialTextureFile(textureFiles, material?.occlusionTexture);
  const emissiveTexture = materialTextureFile(textureFiles, material?.emissiveTexture);
  const metallicRoughnessTexture = materialTextureFile(textureFiles, pbr.metallicRoughnessTexture);
  const emissive = material?.emissiveFactor || [0, 0, 0];

  lines.push("");
  lines.push(`newmtl ${name}`);
  lines.push(`Ka ${color[0]} ${color[1]} ${color[2]}`);
  lines.push(`Kd ${color[0]} ${color[1]} ${color[2]}`);
  lines.push("Ks 0 0 0");
  lines.push(`Ke ${emissive[0]} ${emissive[1]} ${emissive[2]}`);
  lines.push(`d ${color[3] ?? 1}`);
  lines.push(`Ns ${(1 - roughness) * 1000}`);
  lines.push(`Pr ${roughness}`);
  lines.push(`Pm ${metallic}`);
  if (baseColorTexture) {
    lines.push(`map_Ka ${baseColorTexture.filename}`);
    lines.push(`map_Kd ${baseColorTexture.filename}`);
  }
  if (emissiveTexture) lines.push(`map_Ke ${emissiveTexture.filename}`);
  if (normalTexture) lines.push(`norm ${normalTexture.filename}`);
  if (occlusionTexture) lines.push(`map_Ka ${occlusionTexture.filename}`);
  if (metallicRoughnessTexture) {
    lines.push(`map_Pr ${metallicRoughnessTexture.filename}`);
    lines.push(`map_Pm ${metallicRoughnessTexture.filename}`);
  }
}

function buildMtl(gltf, textureFiles, fallbackTextureFile) {
  const lines = ["# Converted from Meshy GLB"];

  appendMtlMaterial(lines, "material_default", null, textureFiles, fallbackTextureFile);

  (gltf.materials || []).forEach((material, index) => {
    appendMtlMaterial(lines, `material_${index + 1}`, material, textureFiles, fallbackTextureFile);
  });

  return `${lines.join("\n")}\n`;
}

function baseColorTextureInfo(gltf, primitive) {
  const material = gltf.materials?.[primitive.material];
  const pbr = material?.pbrMetallicRoughness || {};
  const specGloss = material?.extensions?.KHR_materials_pbrSpecularGlossiness || {};
  return pbr.baseColorTexture || specGloss.diffuseTexture || null;
}

function textureCoordAttribute(gltf, primitive) {
  const textureInfo = baseColorTextureInfo(gltf, primitive);
  const transform = textureInfo?.extensions?.KHR_texture_transform;
  const texCoord = transform?.texCoord ?? textureInfo?.texCoord ?? 0;
  return primitive.attributes?.[`TEXCOORD_${texCoord}`] ?? primitive.attributes?.TEXCOORD_0;
}

function transformTextureCoord(uv, textureInfo) {
  const transform = textureInfo?.extensions?.KHR_texture_transform;
  if (!transform) return uv;

  const offset = transform.offset || [0, 0];
  const scale = transform.scale || [1, 1];
  const rotation = transform.rotation || 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const u = uv[0] * scale[0];
  const v = uv[1] * scale[1];
  return [
    offset[0] + cos * u - sin * v,
    offset[1] + sin * u + cos * v,
  ];
}

function materialDebugInfo(gltf, textureFiles) {
  return {
    materials: (gltf.materials || []).map((material, index) => {
      const pbr = material.pbrMetallicRoughness || {};
      const specGloss = material.extensions?.KHR_materials_pbrSpecularGlossiness || {};
      const baseColorTexture = pbr.baseColorTexture || specGloss.diffuseTexture || null;
      const textureFile = materialTextureFile(textureFiles, baseColorTexture);
      return {
        index,
        objName: `material_${index + 1}`,
        sourceName: material.name || null,
        baseColorFactor: pbr.baseColorFactor || specGloss.diffuseFactor || null,
        textureIndex: baseColorTexture?.index ?? null,
        texCoord: baseColorTexture?.extensions?.KHR_texture_transform?.texCoord ?? baseColorTexture?.texCoord ?? 0,
        textureTransform: baseColorTexture?.extensions?.KHR_texture_transform || null,
        mapKd: textureFile?.filename || null,
      };
    }),
    textures: (gltf.textures || []).map((texture, index) => ({
      index,
      source: texture.source ?? null,
      file: textureFiles.get(index)?.filename || null,
    })),
  };
}

async function glbToTexturedObjFiles(buffer) {
  const { json, bin } = readGlb(buffer);
  const meshNodes = collectMeshNodes(json);
  const { textureFiles, imageFiles } = await buildTextureFiles(json, bin);
  const fallbackTextureFile = textureFiles.values().next().value || imageFiles.values().next().value || null;
  const objLines = ["# Converted from Meshy GLB", "mtllib model.mtl"];
  let vertexOffset = 0;
  let texcoordOffset = 0;
  let objectIndex = 0;

  for (const { node, world } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives || []).length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");

      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      const textureInfo = baseColorTextureInfo(json, primitive);
      const texcoordAttribute = textureCoordAttribute(json, primitive);
      const texcoords = texcoordAttribute === undefined ? null : accessorReader(json, bin, texcoordAttribute);
      const colors = primitive.attributes.COLOR_0 === undefined ? null : accessorReader(json, bin, primitive.attributes.COLOR_0);
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const objectName = sanitizeName(mesh.name || node.name, `mesh_${objectIndex + 1}`);
      objLines.push("");
      objLines.push(`o ${objectName}_${primitiveIndex + 1}`);
      objLines.push(`usemtl ${materialName(json, primitive.material)}`);

      for (let i = 0; i < positions.count; i++) {
        const point = transform(world, positions.get(i));
        if (colors && i < colors.count) {
          const color = colors.get(i);
          const alpha = color[3] ?? 1;
          objLines.push(`v ${point[0]} ${point[1]} ${point[2]} ${color[0] * alpha} ${color[1] * alpha} ${color[2] * alpha}`);
        } else {
          objLines.push(`v ${point[0]} ${point[1]} ${point[2]}`);
        }
      }

      if (texcoords) {
        for (let i = 0; i < texcoords.count; i++) {
          const uv = transformTextureCoord(texcoords.get(i), textureInfo);
          objLines.push(`vt ${uv[0]} ${uv[1]}`);
        }
      }

      const count = indices ? indices.count : positions.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const face = [i, i + 1, i + 2].map((faceIndex) => {
          const vertexIndex = indices ? indices.get(faceIndex)[0] : faceIndex;
          const v = vertexIndex + vertexOffset + 1;
          if (!texcoords || vertexIndex >= texcoords.count) return `${v}`;
          const vt = vertexIndex + texcoordOffset + 1;
          return `${v}/${vt}`;
        });
        objLines.push(`f ${face.join(" ")}`);
      }

      vertexOffset += positions.count;
      texcoordOffset += texcoords?.count || 0;
      objectIndex++;
    }
  }

  if (!objectIndex) throw new Error("GLB does not contain triangle meshes.");

  const files = [
    { name: "model.obj", data: textEncoder.encode(`${objLines.join("\n")}\n`) },
    { name: "model.mtl", data: textEncoder.encode(buildMtl(json, textureFiles, fallbackTextureFile)) },
    { name: "debug-materials.json", data: textEncoder.encode(JSON.stringify(materialDebugInfo(json, textureFiles), null, 2)) },
  ];

  const addedTextures = new Set();
  for (const textureFile of imageFiles.values()) {
    if (addedTextures.has(textureFile.filename)) continue;
    addedTextures.add(textureFile.filename);
    files.push({ name: textureFile.filename, data: textureFile.bytes });
  }

  return files;
}

async function glbToPngTextureFiles(buffer) {
  const { json, bin } = readGlb(buffer);
  const imageFiles = await buildImageFiles(json, bin);
  const files = [];
  for (const file of imageFiles.values()) {
    files.push({ name: file.filename, data: file.bytes });
  }
  if (!files.length) throw new Error("No embedded texture images were found in the decoded GLB.");
  return files;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  function writeHeader(length) {
    const bytes = new Uint8Array(length);
    return { bytes, view: new DataView(bytes.buffer) };
  }

  for (const file of files) {
    const name = textEncoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = writeHeader(30 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, 0, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    localParts.push(local.bytes, data);

    const central = writeHeader(46 + name.length);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, 0, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    centralParts.push(central.bytes);

    offset += local.bytes.length + data.length;
  }

  const centralOffset = offset;
  const centralBytes = concatBytes(centralParts);
  const end = writeHeader(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralBytes.length, true);
  end.view.setUint32(16, centralOffset, true);

  localParts.push(centralBytes, end.bytes);
  return concatBytes(localParts).buffer;
}

async function glbToTexturedObjZip(buffer) {
  return zipFiles(await glbToTexturedObjFiles(buffer));
}

async function glbToPngTextureZip(buffer) {
  return zipFiles(await glbToPngTextureFiles(buffer));
}

async function convert(buffer, format) {
  const mod = await getMeshyModule();
  const result = mod.processMeshyFile(new Uint8Array(buffer));
  if (!result?.success) throw new Error(result?.error || "Failed to decode .meshy.");
  const glb = result.data instanceof Uint8Array ? result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength) : result.data;
  if (format === "glb") return glb;
  if (format === "obj") return glbToObj(glb);
  if (format === "obj-textured") return glbToTexturedObjZip(glb);
  if (format === "textures-png") return glbToPngTextureZip(glb);
  if (format === "stl") return glbToBinaryStl(glb);
  throw new Error(`Unsupported output format: ${format}`);
}

window.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;
  try {
    const output = await convert(event.data.buffer, event.data.format);
    event.source.postMessage({ id: event.data.id, ok: true, output }, event.origin, [output]);
  } catch (error) {
    event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, event.origin);
  }
});
