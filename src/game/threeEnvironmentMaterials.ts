import * as THREE from "three";

// One deterministic texture set per ride, shared across every stage. No network
// assets or per-frame canvases; ownership stays here rather than on each prop.
export const environmentRandom = (seed: number): (() => number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

export type Surface = "grass" | "asphalt" | "gravel" | "bark" | "straw" | "wound" | "plaster" | "tiles" | "stone" | "wood" | "leaf" | "foliage" | "needles";

export class EnvironmentMaterials {
  readonly time = { value: 0 };
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly shadows = new Map<Surface, THREE.MeshDepthMaterial>();
  private readonly textures = new Map<Surface, THREE.DataTexture>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();

  texture(surface: Surface): THREE.DataTexture {
    const cached = this.textures.get(surface);
    if (cached) return cached;
    const size = 256;
    const pixels = new Uint8Array(size * size * 4);
    const random = environmentRandom(391 + surface.length * 53);
    const tileNoise = (x: number, y: number, cellsX: number, cellsY = cellsX): number => {
      const px = x / size * cellsX, py = y / size * cellsY;
      const ix = Math.floor(px), iy = Math.floor(py);
      const smooth = (v: number) => v * v * (3 - 2 * v);
      const u = smooth(px - ix), v = smooth(py - iy);
      const hash = (a: number, b: number) => environmentRandom(((a + cellsX) % cellsX) * 1931 + ((b + cellsY) % cellsY) * 719 + 853)();
      return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix,iy),hash(ix+1,iy),u),THREE.MathUtils.lerp(hash(ix,iy+1),hash(ix+1,iy+1),u),v);
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const grain = random();
      const patch = tileNoise(x,y,4) * 0.55 + tileNoise(x,y,8) * 0.3 + tileNoise(x,y,16) * 0.15;
      let value = 0.7 + grain * 0.3;
      if (surface === "grass") value = 0.7 + patch * 0.15 + grain * 0.15;
      if (surface === "asphalt") value = grain > 0.94 ? 0.95 : 0.45 + grain * 0.25;
      if (surface === "gravel") value = 0.45 + Math.floor(grain * 5) * 0.11;
      if (surface === "bark" || surface === "wood") value = 0.52 + tileNoise(x,y,32,3) * 0.36 + grain * 0.1;
      if (surface === "straw") value = 0.63 + 0.18 * Math.sin(y * Math.PI / 2 + Math.sin(x * Math.PI / 128) * 4) + grain * 0.17;
      if (surface === "wound") {
        const dx = x - 127.5, dy = y - 127.5;
        const radius = Math.hypot(dx, dy);
        value = 0.66 + Math.sin(radius * 0.85 + Math.atan2(dy, dx) * 2) * 0.18 + grain * 0.16;
      }
      if (surface === "plaster") value = 0.82 + grain * 0.13 + patch * 0.03;
      if (surface === "tiles") {
        const row = Math.floor(y / 32);
        const mortar = y % 32 < 3 || (x + (row % 2) * 16) % 32 < 2;
        value = mortar ? 0.37 : 0.68 + grain * 0.12 + Math.sin((y % 32) / 32 * Math.PI) * 0.16;
      }
      if (surface === "stone") {
        const mortar = y % 32 < 2 || (x + (Math.floor(y / 32) % 2) * 32) % 64 < 2;
        value = mortar ? 0.4 : 0.64 + grain * 0.23 + patch * 0.05;
      }
      if (surface === "leaf" || surface === "foliage") value = 0.6 + grain * 0.18 + Math.abs(Math.sin(x * 0.12 + y * 0.15)) * 0.2;
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(value * 255);
      pixels[i + 1] = Math.round(value * 255);
      pixels[i + 2] = Math.round(value * 255);
      let alpha=255;
      if(surface==="foliage") {
        const nx=(x-127.5)/116, ny=(y-127.5)/124;
        // Oval leaf with a tapered tip, small edge variation and a midrib.
        const edge=nx*nx+ny*ny+(ny>0 ? ny*nx*nx*0.2 : 0);
        alpha=edge<0.94+0.025*Math.sin(y*0.35) ? 255 : 0;
        if(Math.abs(nx)<0.025 || Math.abs(Math.sin((y+Math.abs(x-128)*0.7)*0.12))<0.08) {
          pixels[i]=pixels[i+1]=pixels[i+2]=155;
        }
      }
      if(surface==="needles") {pixels[i]=pixels[i+1]=pixels[i+2]=210;alpha=0;}
      pixels[i + 3] = alpha;
    }
    if(surface==="needles") {
      const draw = (x0:number,y0:number,x1:number,y1:number,width:number,value:number) => {
        const steps=Math.ceil(Math.hypot(x1-x0,y1-y0)*1.5);
        for(let step=0;step<=steps;step++) {
          const x=THREE.MathUtils.lerp(x0,x1,step/steps),y=THREE.MathUtils.lerp(y0,y1,step/steps);
          for(let dy=-Math.ceil(width);dy<=Math.ceil(width);dy++) for(let dx=-Math.ceil(width);dx<=Math.ceil(width);dx++) {
            const px=Math.round(x+dx),py=Math.round(y+dy);
            if(px<0||px>=size||py<0||py>=size||Math.hypot(px-x,py-y)>width)continue;
            const i=(py*size+px)*4;pixels[i]=pixels[i+1]=pixels[i+2]=value;pixels[i+3]=255;
          }
        }
      };
      draw(128,0,128,246,1.8,140);
      for(let level=0;level<12;level++) for(const side of [-1,1]) {
        const y=18+level*18,reach=88-level*5;
        draw(128,y,128+side*reach,y+22,1.2,155);
        for(let needle=0;needle<10;needle++) {
          const t=0.08+needle*0.09,x=128+side*reach*t,ny=y+22*t;
          draw(x,ny,x+side*(9+random()*8),ny+12+random()*9,0.85,180+random()*65);
          draw(x,ny,x+side*(6+random()*6),ny-10-random()*7,0.85,180+random()*65);
        }
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    this.textures.set(surface, texture);
    return texture;
  }

  material(surface: Surface, color: number, wind = false): THREE.MeshStandardMaterial {
    const key = `${surface}-${color}-${wind}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const map = this.texture(surface);
    const material = new THREE.MeshStandardMaterial({
      color, map, bumpMap: wind ? null : map, bumpScale: surface === "bark" ? 0.06 : surface === "plaster" ? 0.015 : surface === "grass" ? 0.018 : 0.035,
      roughness: 0.95, side: wind ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: surface === "needles" ? 0.18 : surface === "foliage" ? 0.35 : 0,
      alphaToCoverage: surface === "foliage" || surface === "needles",
    });
    material.userData.environmentShared = true;
    if (wind) {
      material.onBeforeCompile = shader => this.addWind(shader, surface === "foliage" ? 0.018 : 0.075);
      material.customProgramCacheKey = () => `environment-wind-${surface}-v2`;
    }
    this.materials.set(key, material);
    return material;
  }

  private addWind(shader: Parameters<THREE.Material["onBeforeCompile"]>[0], strength: number): void {
    shader.uniforms.environmentTime = this.time;
    shader.vertexShader = `uniform float environmentTime;\n${shader.vertexShader}`.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vec3 windPosition = position;
      #ifdef USE_INSTANCING
        windPosition = (instanceMatrix * vec4(position, 1.0)).xyz;
      #endif
      float gust = sin(environmentTime * 1.6 + windPosition.x * 0.63 + windPosition.z * 0.37);
      transformed.x += gust * ${strength.toFixed(3)} * uv.y * uv.y;
      transformed.z += sin(environmentTime * 1.1 + windPosition.x) * ${(strength*0.45).toFixed(4)} * uv.y;
    `);
  }


  windDepth(surface: Surface): THREE.MeshDepthMaterial {
    let material = this.shadows.get(surface);
    if (!material) {
      material = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, map: this.texture(surface), side: THREE.DoubleSide, alphaTest: surface === "needles" ? 0.18 : surface === "foliage" ? 0.35 : 0});
      material.userData.environmentShared = true;
      material.onBeforeCompile = shader => this.addWind(shader, surface === "foliage" ? 0.018 : 0.075);
      material.customProgramCacheKey = () => `environment-wind-depth-${surface}-v2`;
      this.shadows.set(surface, material);
    }
    return material;
  }

  geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = create();
      geometry.userData.environmentShared = true;
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  dispose(): void {
    this.materials.forEach(material => material.dispose());
    this.shadows.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.clear(); this.shadows.clear(); this.textures.clear(); this.geometries.clear();
  }
}
