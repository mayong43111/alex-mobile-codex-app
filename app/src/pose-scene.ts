import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { VRM, VRMHumanoid, VRMUtils } from '@pixiv/three-vrm'
import type { VRMHumanBoneName, VRMHumanBones } from '@pixiv/three-vrm'

export type PoseAngles = Record<string, [number, number, number]>
export type PosePlacement = { grounded: boolean; height: number }
export type PosePreset = { id: string; name: string; folder: string; joints: PoseAngles; placement: PosePlacement; rotation: number }
export const poseJoints = [
  ['root', '身体转向', 'hips'], ['torso', '腰部', 'spine'], ['chest', '胸部', 'chest'], ['head', '头部', 'head'],
  ['leftUpperArm', '左上臂', 'leftUpperArm'], ['leftLowerArm', '左前臂', 'leftLowerArm'], ['leftHand', '左手', 'leftHand'],
  ['rightUpperArm', '右上臂', 'rightUpperArm'], ['rightLowerArm', '右前臂', 'rightLowerArm'], ['rightHand', '右手', 'rightHand'],
  ['leftUpperLeg', '左大腿', 'leftUpperLeg'], ['leftLowerLeg', '左小腿', 'leftLowerLeg'], ['leftFoot', '左脚', 'leftFoot'],
  ['rightUpperLeg', '右大腿', 'rightUpperLeg'], ['rightLowerLeg', '右小腿', 'rightLowerLeg'], ['rightFoot', '右脚', 'rightFoot'],
] as const

function mannequin(model: THREE.Group) {
  const names: Record<string, string> = { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'Head' }
  for (const [side, suffix] of [['left', 'l'], ['right', 'r']]) {
    for (const [joint, source] of Object.entries({ Shoulder: 'clavicle', UpperArm: 'upperarm', LowerArm: 'lowerarm', Hand: 'hand', UpperLeg: 'thigh', LowerLeg: 'calf', Foot: 'foot', Toes: 'ball' })) names[`${side}${joint}`] = `${source}_${suffix}`
    for (const [finger, source] of [['Thumb', 'thumb'], ['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) {
      const segments = finger === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']
      segments.forEach((segment, index) => { names[`${side}${finger}${segment}`] = `${source}_0${index + 1}_${suffix}` })
    }
  }
  const bones = Object.fromEntries(Object.entries(names).map(([name, source]) => {
    const node = model.getObjectByName(source)
    if (!(node instanceof THREE.Bone)) throw new Error(`人偶缺少骨骼：${source}`)
    return [name, { node }]
  })) as unknown as VRMHumanBones
  const root = new THREE.Group()
  root.add(model)
  root.updateMatrixWorld(true)
  if (bones.leftUpperArm.node.getWorldPosition(new THREE.Vector3()).x < bones.rightUpperArm.node.getWorldPosition(new THREE.Vector3()).x) model.rotation.y += Math.PI
  root.updateMatrixWorld(true)
  for (const side of ['left', 'right'] as const) {
    const direction = new THREE.Vector3(side === 'left' ? 1 : -1, 0, 0)
    for (const [joint, child] of [['UpperArm', 'LowerArm'], ['LowerArm', 'Hand']] as const) {
      const bone = bones[`${side}${joint}`]!.node
      const endpoint = bones[`${side}${child}`]!.node
      const current = endpoint.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize()
      const rotation = new THREE.Quaternion().setFromUnitVectors(current, direction).multiply(bone.getWorldQuaternion(new THREE.Quaternion()))
      bone.quaternion.copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation))
      root.updateMatrixWorld(true)
    }
  }
  const humanoid = new VRMHumanoid(bones)
  root.add(humanoid.normalizedHumanBonesRoot)
  return new VRM({ scene: root, humanoid, meta: { metaVersion: '1', name: 'Quaternius Mannequin', authors: ['Quaternius'], licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' } })
}

export class PoseScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100)
  private controls: OrbitControls
  private figure = new THREE.Group()
  private avatar?: VRM
  private observer: ResizeObserver
  private disposed = false
  private host: HTMLElement
  private gizmo: TransformControls
  private markers = new THREE.Group()
  private selected: string | null = null
  private angles: PoseAngles = {}
  private editable = true
  private changed = false
  private pointerStart?: { x: number; y: number; id: number }
  private finishPose: (angles: PoseAngles) => void
  private selectJoint: (label: string | null) => void

  constructor(host: HTMLElement, onChange: (angles: PoseAngles) => void = () => {}, onSelect: (label: string | null) => void = () => {}) {
    this.host = host
    this.finishPose = onChange
    this.selectJoint = onSelect
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor('#edf0ef')
    this.renderer.domElement.setAttribute('aria-label', '三维姿势人偶')
    host.append(this.renderer.domElement)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enablePan = false
    this.controls.minDistance = 2.8
    this.controls.maxDistance = 10
    this.controls.maxPolarAngle = Math.PI * 0.88
    this.controls.addEventListener('change', this.render)
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement)
    this.gizmo.setMode('rotate')
    this.gizmo.setSpace('local')
    this.gizmo.setSize(0.85)
    this.scene.add(this.gizmo.getHelper(), this.markers)
    this.gizmo.addEventListener('change', this.render)
    this.gizmo.addEventListener('mouseDown', () => { this.changed = false })
    this.gizmo.addEventListener('dragging-changed', event => { this.controls.enabled = !event.value })
    this.gizmo.addEventListener('objectChange', () => {
      if (!this.avatar || !this.selected) return
      const node = this.jointNode(this.selected)!
      this.angles = { ...this.angles, [this.selected]: [node.rotation.x, node.rotation.y, node.rotation.z] }
      this.changed = true
      this.avatar.update(0)
      this.render()
    })
    this.gizmo.addEventListener('mouseUp', () => {
      if (this.changed) { this.changed = false; this.finishPose(structuredClone(this.angles)) }
    })
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown, true)
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp)
    this.renderer.domElement.addEventListener('pointercancel', this.pointerCancel)
    this.renderer.domElement.addEventListener('keydown', this.keyDown)
    this.renderer.domElement.tabIndex = 0
    this.scene.add(this.figure, new THREE.HemisphereLight(0xffffff, 0x66756d, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 3)
    light.position.set(3, 5, 4)
    this.scene.add(light)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.home()
    this.resize()
  }

  async load() {
    const gltf = await new GLTFLoader().loadAsync('/pose/quaternius-original.glb')
    if (this.disposed) { VRMUtils.deepDispose(gltf.scene); return }
    try { this.avatar = mannequin(gltf.scene) }
    catch (failure) { VRMUtils.deepDispose(gltf.scene); throw failure }
    this.figure.add(this.avatar.scene)
    const height = new THREE.Box3().setFromObject(this.figure, true).getSize(new THREE.Vector3()).y
    if (!Number.isFinite(height) || height <= 0) throw new Error('人偶尺寸无效')
    this.figure.scale.setScalar(2 / height)
    for (const [id, label] of poseJoints) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color: '#087f6b', depthTest: false }))
      marker.userData = { joint: id, label }
      marker.renderOrder = 1
      this.markers.add(marker)
    }
    this.apply({})
  }

  private jointNode(id: string) {
    const name = poseJoints.find(joint => joint[0] === id)?.[2] ?? id as VRMHumanBoneName
    return this.avatar?.humanoid.getNormalizedBoneNode(name)
  }

  apply(angles: PoseAngles, placement: PosePlacement = { grounded: true, height: 0 }, rotation = 0, reframe = false) {
    if (!this.avatar || this.disposed) return
    this.angles = structuredClone(angles)
    this.avatar.humanoid.resetNormalizedPose()
    for (const [id, rotation] of Object.entries(angles)) {
      const node = this.jointNode(id)
      if (node) node.rotation.set(...rotation)
    }
    this.avatar.update(0)
    this.figure.rotation.y = rotation
    this.figure.position.y = 0
    this.figure.updateMatrixWorld(true)
    this.figure.position.y = placement.grounded ? -new THREE.Box3().setFromObject(this.figure, true).min.y : placement.height * 2 / 3.2
    if (reframe && this.host.closest('[data-fullscreen=true]')) this.frameFigure()
    this.render()
  }

  setEditingEnabled(enabled: boolean) {
    this.editable = enabled
    this.gizmo.enabled = enabled
    this.markers.visible = enabled
    if (!enabled) this.select(null)
    this.render()
  }

  private select(id: string | null) {
    this.selected = id
    const node = id ? this.jointNode(id) : null
    if (node) this.gizmo.attach(node)
    else this.gizmo.detach()
    this.host.dataset.selectedJoint = id ?? ''
    this.selectJoint(poseJoints.find(joint => joint[0] === id)?.[1] ?? null)
    for (const marker of this.markers.children) (marker as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>).material.color.set(marker.userData.joint === id ? '#bd6d18' : '#087f6b')
    this.render()
  }

  private pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || !this.editable) return
    this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
    this.renderer.domElement.focus({ preventScroll: true })
  }

  private pointerUp = (event: PointerEvent) => {
    const start = this.pointerStart
    this.pointerStart = undefined
    if (!start || start.id !== event.pointerId || !this.editable || this.gizmo.dragging || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer, this.camera)
    const marker = raycaster.intersectObjects(this.markers.children, false)[0]?.object
    if (marker) { this.select(marker.userData.joint); return }
    const hit = raycaster.intersectObject(this.figure, true)[0]
    if (!hit) { this.select(null); return }
    let nearest: string | null = null
    let distance = Infinity
    for (const [id] of poseJoints) {
      const node = this.jointNode(id)
      if (!node) continue
      const candidate = node.getWorldPosition(new THREE.Vector3()).distanceToSquared(hit.point)
      if (candidate < distance) { distance = candidate; nearest = id }
    }
    this.select(nearest)
  }

  private pointerCancel = () => {
    this.pointerStart = undefined
    if (this.gizmo.dragging) {
      this.gizmo.reset()
      this.changed = false
      this.gizmo.pointerUp(null)
    }
    this.controls.enabled = true
  }

  private keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { this.select(null); event.stopPropagation() }
  }

  home = () => {
    this.camera.position.set(0, 1.15, 5.8)
    this.controls.target.set(0, 1.05, 0)
    this.controls.update()
    this.frameFigure()
    this.render()
  }

  zoom(factor: number) {
    this.camera.position.sub(this.controls.target).multiplyScalar(factor).add(this.controls.target)
    this.controls.update()
  }

  private resize() {
    const { width, height } = this.host.getBoundingClientRect()
    if (!width || !height) return
    this.renderer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.frameFigure()
    this.render()
  }

  private frameFigure() {
    if (!this.avatar) return
    const bounds = new THREE.Box3().setFromObject(this.figure, true)
    const center = bounds.getCenter(new THREE.Vector3())
    const direction = this.camera.position.clone().sub(this.controls.target).normalize()
    this.camera.position.copy(center).add(direction)
    this.camera.lookAt(center)
    const inverse = this.camera.quaternion.clone().invert()
    const height = this.host.clientHeight
    const inset = Number.parseFloat(getComputedStyle(this.host).getPropertyValue('--pose-frame-inset')) || 16
    const verticalSpace = Math.max(0.2, 1 - 2 * inset / height)
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    let distance = this.controls.minDistance
    for (const horizontal of [bounds.min.x, bounds.max.x]) {
      for (const vertical of [bounds.min.y, bounds.max.y]) {
        for (const depth of [bounds.min.z, bounds.max.z]) {
          const corner = new THREE.Vector3(horizontal, vertical, depth).sub(center).applyQuaternion(inverse)
          distance = Math.max(distance, corner.z + Math.max(Math.abs(corner.x) / (tangent * this.camera.aspect * 0.86), Math.abs(corner.y) / (tangent * verticalSpace)))
        }
      }
    }
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(direction, distance)
    this.controls.maxDistance = Math.max(10, distance * 2)
    this.controls.update()
  }

  private render = () => {
    if (this.disposed) return
    this.figure.updateMatrixWorld(true)
    for (const marker of this.markers.children) this.jointNode(marker.userData.joint)?.getWorldPosition(marker.position)
    this.renderer.render(this.scene, this.camera)
  }

  capture() {
    if (!this.avatar || this.disposed) throw new Error('人偶尚未就绪')
    const size = this.renderer.getSize(new THREE.Vector2())
    const ratio = this.renderer.getPixelRatio()
    const markersVisible = this.markers.visible
    const helper = this.gizmo.getHelper()
    const helperVisible = helper.visible
    try {
      this.markers.visible = false
      helper.visible = false
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(768, Math.round(768 / this.camera.aspect), false)
      this.render()
      const copy = document.createElement('canvas')
      copy.width = this.renderer.domElement.width
      copy.height = this.renderer.domElement.height
      copy.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0)
      return copy
    } finally {
      this.markers.visible = markersVisible
      helper.visible = helperVisible
      this.renderer.setPixelRatio(ratio)
      this.renderer.setSize(size.x, size.y)
      this.render()
    }
  }

  dispose() {
    this.disposed = true
    this.observer.disconnect()
    this.controls.dispose()
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown, true)
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp)
    this.renderer.domElement.removeEventListener('pointercancel', this.pointerCancel)
    this.renderer.domElement.removeEventListener('keydown', this.keyDown)
    this.gizmo.dispose()
    this.gizmo.getHelper().removeFromParent()
    VRMUtils.deepDispose(this.scene)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

export async function poseReferenceBoard(pose: HTMLCanvasElement, person: Blob) {
  if (!person.size || person.size > 64 * 1024 * 1024) throw new Error('人物图片必须为非空文件且不超过 64 MB')
  const image = await createImageBitmap(person)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1536
    canvas.height = 1024
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const contain = (source: CanvasImageSource, width: number, height: number, left: number) => {
      const scale = Math.min(744 / width, 952 / height)
      context.drawImage(source, left + (768 - width * scale) / 2, 60 + (952 - height * scale) / 2, width * scale, height * scale)
    }
    contain(pose, pose.width, pose.height, 0)
    contain(image, image.width, image.height, 768)
    context.fillStyle = '#263b30'
    context.font = 'bold 24px sans-serif'
    context.fillText('A: POSE / CAMERA ONLY', 24, 38)
    context.fillText('B: PERSON / IDENTITY', 792, 38)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法导出参考板')), 'image/png'))
    return new File([blob], 'pose-person-reference.png', { type: 'image/png' })
  } finally { image.close() }
}