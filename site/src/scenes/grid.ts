import * as THREE from 'three'

// A drifting field of glowing points with faint connecting lines, on the deep
// background. Pointer parallax. Cheap enough for the hero without a framework.
export function initGrid(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.z = 18

  const COUNT = 90
  const SPREAD = 34
  const positions = new Float32Array(COUNT * 3)
  const velocities: number[] = []
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * SPREAD
    positions[i * 3 + 1] = (Math.random() - 0.5) * SPREAD * 0.6
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10
    velocities.push((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, 0)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0x89b4fa, size: 0.16, transparent: true, opacity: 0.9 }),
  )
  scene.add(points)

  const lineGeo = new THREE.BufferGeometry()
  const lineMat = new THREE.LineBasicMaterial({ color: 0xa6e3a1, transparent: true, opacity: 0.14 })
  const lines = new THREE.LineSegments(lineGeo, lineMat)
  scene.add(lines)

  const MAX_DIST = 6
  function rebuildLines() {
    const segs: number[] = []
    for (let i = 0; i < COUNT; i++) {
      for (let j = i + 1; j < COUNT; j++) {
        const dx = positions[i * 3] - positions[j * 3]
        const dy = positions[i * 3 + 1] - positions[j * 3 + 1]
        const dz = positions[i * 3 + 2] - positions[j * 3 + 2]
        if (dx * dx + dy * dy + dz * dz < MAX_DIST * MAX_DIST) {
          segs.push(
            positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
            positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2],
          )
        }
      }
    }
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
  }

  let mx = 0, my = 0
  addEventListener('pointermove', (e) => {
    mx = (e.clientX / innerWidth - 0.5) * 2
    my = (e.clientY / innerHeight - 0.5) * 2
  }, { passive: true })

  function resize() {
    const w = innerWidth, h = innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  addEventListener('resize', resize)
  resize()

  let raf = 0
  let frame = 0
  function loop() {
    raf = requestAnimationFrame(loop)
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] += velocities[i * 3]
      positions[i * 3 + 1] += velocities[i * 3 + 1]
      if (Math.abs(positions[i * 3]) > SPREAD / 2) velocities[i * 3] *= -1
      if (Math.abs(positions[i * 3 + 1]) > SPREAD * 0.3) velocities[i * 3 + 1] *= -1
    }
    geo.attributes.position.needsUpdate = true
    if (frame++ % 3 === 0) rebuildLines()

    camera.position.x += (mx * 2.4 - camera.position.x) * 0.04
    camera.position.y += (-my * 1.6 - camera.position.y) * 0.04
    camera.lookAt(0, 0, 0)
    points.rotation.z += 0.0004
    renderer.render(scene, camera)
  }
  loop()

  // Pause when offscreen / tab hidden to save battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf)
    else loop()
  })
}
