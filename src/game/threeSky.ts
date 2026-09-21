import * as THREE from "three";

/** A single sky dome: soft cloud banks, warm sunlight, and horizon haze. */
export const createSkyMaterial = (): THREE.ShaderMaterial => new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: {
    top: { value: new THREE.Color(0x438ebb) },
    horizon: { value: new THREE.Color(0xf4e6c5) },
    time: { value: 0 },
    cloudCoverage: { value: 0.52 },
  },
  vertexShader: `varying vec3 direction;
    void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform vec3 top, horizon;
    uniform float time, cloudCoverage;
    varying vec3 direction;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                 mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float cloudNoise(vec2 p) {
      float n = 0.0, amplitude = 0.55;
      for (int i = 0; i < 4; i++) {
        n += noise(p) * amplitude;
        p = mat2(1.6, -1.2, 1.2, 1.6) * p + 9.4;
        amplitude *= 0.48;
      }
      return n;
    }
    void main() {
      vec3 ray = normalize(direction);
      float elevation = max(ray.y, 0.0);
      vec3 color = mix(horizon, top, smoothstep(-0.04, 0.3, ray.y));
      vec3 sun = normalize(vec3(-0.55, 0.7, -0.45));
      float sunAngle = max(dot(ray, sun), 0.0);
      color += vec3(1.0, 0.68, 0.34) * pow(sunAngle, 12.0) * 0.16;
      color += vec3(1.0, 0.88, 0.6) * pow(sunAngle, 420.0) * 1.2;
      // Projection onto a high cloud layer makes clouds recede naturally.
      vec2 p = ray.xz / max(ray.y, 0.06) * 1.8 + vec2(time * 0.006, time * 0.002);
      float density = cloudNoise(p + cloudNoise(p * 0.4) * 0.8);
      float cloud = smoothstep(cloudCoverage - 0.08, cloudCoverage + 0.12, density);
      cloud *= smoothstep(0.015, 0.16, elevation);
      vec3 underside = mix(vec3(0.61, 0.7, 0.76), horizon, 0.25);
      vec3 cloudColor = mix(underside, vec3(1.0, 0.98, 0.91), smoothstep(cloudCoverage, 0.78, density));
      cloudColor += vec3(0.18, 0.12, 0.05) * pow(sunAngle, 8.0);
      color = mix(color, cloudColor, cloud * 0.91);
      gl_FragColor = vec4(color, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
});
