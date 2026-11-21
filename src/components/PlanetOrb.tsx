import { useEffect, useRef } from 'react';

export type PlanetKind = 'earth' | 'jupiter' | 'mercury' | 'sun';

interface PlanetOrbProps {
  kind: PlanetKind;
  size?: number;
  className?: string;
}

// Fast deterministic 3D value noise for spherical planetary textures
function hash3(x: number, y: number, z: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  return lerp(
    lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
    lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
    fz,
  );
}

function fbm(x: number, y: number, z: number, octaves = 5): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    value += amp * noise3(x * freq, y * freq, z * freq);
    freq *= 2.08;
    amp *= 0.5;
  }
  return value;
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n | 0;
}

function renderPlanet(canvas: HTMLCanvasElement, kind: PlanetKind, size: number) {
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const pxSize = Math.round(size * dpr);
  canvas.width = pxSize;
  canvas.height = pxSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const img = ctx.createImageData(pxSize, pxSize);
  const data = img.data;

  const cx = pxSize / 2;
  const cy = pxSize / 2;
  // Leave subtle padding for outer atmospheric corona
  const padRatio = kind === 'sun' ? 0.82 : 0.9;
  const radius = (pxSize / 2) * padRatio;

  // Light direction (upper-left-front for rich 3D form)
  const lx = kind === 'sun' ? 0.15 : -0.46;
  const ly = kind === 'sun' ? -0.15 : -0.34;
  const lz = kind === 'sun' ? 0.98 : 0.82;

  for (let py = 0; py < pxSize; py++) {
    const dy = (py - cy) / radius;
    const dy2 = dy * dy;

    for (let px = 0; px < pxSize; px++) {
      const dx = (px - cx) / radius;
      const dist2 = dx * dx + dy2;
      const idx = (py * pxSize + px) * 4;

      if (dist2 > 1) {
        // Subtle outer glow
        if (kind === 'sun' || kind === 'earth') {
          const dist = Math.sqrt(dist2);
          const falloff = Math.max(0, 1 - (dist - 1) / (kind === 'sun' ? 0.22 : 0.08));
          const glow = falloff * falloff * (kind === 'sun' ? 0.55 : 0.28);
          if (glow > 0.004) {
            if (kind === 'sun') {
              data[idx] = 245;
              data[idx + 1] = 138;
              data[idx + 2] = 42;
              data[idx + 3] = clampByte(glow * 255);
            } else {
              data[idx] = 115;
              data[idx + 1] = 175;
              data[idx + 2] = 255;
              data[idx + 3] = clampByte(glow * 255);
            }
          }
        }
        continue;
      }

      const nz = Math.sqrt(Math.max(0, 1 - dist2));
      const nx = dx;
      const ny = dy;

      // Anti-aliased sphere edge
      const dist = Math.sqrt(dist2);
      const edgeAlpha = dist > 0.985 ? Math.max(0, (1 - dist) / 0.015) : 1;

      // Diffuse + limb darkening
      const dot = nx * lx + ny * ly + nz * lz;
      const diffuse = Math.max(0.06, dot);
      const limb = Math.pow(nz, 0.38);
      const rim = Math.pow(1 - nz, 3.0);

      let r = 0;
      let g = 0;
      let b = 0;

      if (kind === 'earth') {
        // Rotate coords so Africa/Europe-like landmass faces front like the screenshot
        const sx = nx * 2.1 + 1.4;
        const sy = ny * 2.1 - 0.3;
        const sz = nz * 2.1 + 0.8;

        const continent = fbm(sx, sy, sz, 5);
        const detail = fbm(sx * 3.1 + 4.2, sy * 3.1, sz * 3.1, 4);
        const clouds = fbm(sx * 1.9 - 2.1, sy * 2.6 + 1.1, sz * 1.9, 4);

        const isLand = continent + (detail - 0.5) * 0.14 > 0.505;
        if (isLand) {
          // Desert ochre vs forest green
          const arid = smooth(Math.max(0, Math.min(1, (0.56 - Math.abs(ny + 0.05)) * 1.8 + (detail - 0.5) * 0.6)));
          r = lerp(58, 206, arid) + (detail - 0.5) * 38;
          g = lerp(118, 174, arid) + (detail - 0.5) * 28;
          b = lerp(66, 102, arid) + (detail - 0.5) * 18;
        } else {
          // Deep ocean + shallow shelf
          const shelf = smooth(Math.max(0, (continent - 0.41) / 0.1));
          r = lerp(24, 52, shelf);
          g = lerp(64, 128, shelf);
          b = lerp(146, 204, shelf);

          // Ocean sun specular glint
          const spec = Math.pow(Math.max(0, dot), 22) * 0.22;
          r += spec * 200;
          g += spec * 220;
          b += spec * 255;
        }

        // Polar ice hints
        const polar = smooth(Math.max(0, (Math.abs(ny) - 0.78) * 4.5));
        r = lerp(r, 236, polar);
        g = lerp(g, 244, polar);
        b = lerp(b, 252, polar);

        // Cloud veil
        const cloudDensity = Math.max(0, (clouds - 0.54) * 2.35);
        const cloudMix = Math.min(0.86, cloudDensity);
        r = lerp(r, 245, cloudMix);
        g = lerp(g, 249, cloudMix);
        b = lerp(b, 255, cloudMix);

        // Lighting + atmospheric blue Fresnel rim
        const shade = (0.16 + 0.94 * diffuse) * (0.72 + 0.28 * limb);
        r = r * shade + rim * 92;
        g = g * shade + rim * 165;
        b = b * shade + rim * 255;
      } else if (kind === 'jupiter') {
        const warp = (fbm(nx * 3.4, ny * 2.2, nz * 3.4, 4) - 0.5) * 0.24;
        const lat = ny * 7.8 + warp;
        const bandVal = Math.sin(lat * 3.2) * 0.5 + 0.5;
        const fineBand = Math.sin(lat * 9.5 + warp * 5) * 0.5 + 0.5;
        const swirl = fbm(nx * 6.5 + warp * 2, ny * 11, nz * 6.5, 4);

        // Cream zones vs sienna/ochre belts
        const beltMix = smooth(bandVal * 0.72 + fineBand * 0.28);
        r = lerp(186, 236, beltMix) + (swirl - 0.5) * 34;
        g = lerp(128, 214, beltMix) + (swirl - 0.5) * 30;
        b = lerp(84, 188, beltMix) + (swirl - 0.5) * 24;

        // Great Red Spot
        const spotX = (nx + 0.34) / 0.22;
        const spotY = (ny - 0.24) / 0.13;
        const spotD = spotX * spotX + spotY * spotY;
        if (spotD < 1.2) {
          const spotMix = smooth(Math.max(0, 1 - spotD / 1.2));
          r = lerp(r, 208, spotMix * 0.85);
          g = lerp(g, 108, spotMix * 0.85);
          b = lerp(b, 64, spotMix * 0.85);
        }

        const shade = (0.2 + 0.92 * diffuse) * (0.65 + 0.35 * limb);
        r = r * shade + rim * 48;
        g = g * shade + rim * 34;
        b = b * shade + rim * 22;
      } else if (kind === 'mercury') {
        const base = fbm(nx * 4.2 + 3.1, ny * 4.2 - 1.7, nz * 4.2, 5);
        const micro = fbm(nx * 14, ny * 14, nz * 14, 3);
        const craters = fbm(nx * 9.5 - 4.0, ny * 9.5 + 2.2, nz * 9.5, 4);

        // Crater pit contrast
        const pit = craters < 0.36 ? (0.36 - craters) * -0.9 : craters > 0.68 ? (craters - 0.68) * 0.75 : 0;
        const albedo = 128 + (base - 0.5) * 65 + (micro - 0.5) * 36 + pit * 70;

        const shade = (0.14 + 0.95 * diffuse) * (0.68 + 0.32 * limb);
        r = (albedo + 8) * shade + rim * 44;
        g = (albedo + 4) * shade + rim * 42;
        b = (albedo - 2) * shade + rim * 38;
      } else {
        // Sun: molten granulation + warm corona limb
        const gran = fbm(nx * 5.2 + 1.2, ny * 5.2 + 0.8, nz * 5.2, 5);
        const flare = fbm(nx * 12.0 - 2.3, ny * 12.0, nz * 12.0, 4);
        const heat = Math.min(1, Math.max(0, gran * 0.7 + flare * 0.3 + (nz - 0.5) * 0.25));

        r = lerp(218, 255, heat);
        g = lerp(74, 212, heat * heat);
        b = lerp(18, 108, Math.pow(heat, 3));

        // Intense corona rim
        r = r * (0.78 + 0.22 * limb) + rim * 255 * 0.35;
        g = g * (0.74 + 0.26 * limb) + rim * 120 * 0.35;
        b = b * (0.7 + 0.3 * limb) + rim * 30 * 0.35;
      }

      data[idx] = clampByte(r);
      data[idx + 1] = clampByte(g);
      data[idx + 2] = clampByte(b);
      data[idx + 3] = clampByte(edgeAlpha * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
}

const ORB_CACHE = new Map<string, string>();

export function PlanetOrb({ kind, size = 188, className = '' }: PlanetOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const cacheKey = `${kind}:${size}:${dpr}`;
    const cachedUrl = ORB_CACHE.get(cacheKey);
    const pxSize = Math.round(size * dpr);

    if (cachedUrl) {
      canvas.width = pxSize;
      canvas.height = pxSize;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          ctx.clearRect(0, 0, pxSize, pxSize);
          ctx.drawImage(img, 0, 0, pxSize, pxSize);
        };
        img.src = cachedUrl;
      }
      return () => {
        cancelled = true;
      };
    }

    renderPlanet(canvas, kind, size);
    try {
      ORB_CACHE.set(cacheKey, canvas.toDataURL('image/png'));
    } catch {
      // Ignore canvas export errors
    }

    return () => {
      cancelled = true;
    };
  }, [kind, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`block select-none pointer-events-none ${className}`}
    />
  );
}
