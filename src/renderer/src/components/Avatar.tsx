import { memo, useState } from 'react'
import { colorOf, initials } from '../format'
import { useStore } from '../state'

/** id → connection generation it failed in; a new connection gives every miss one more try */
const failed = new Map<string, number>()
const loaded = new Set<string>()

/** blob-shaped avatar: initials on a colored blob, real profile photo when WhatsApp has one */
export const Avatar = memo(function Avatar({ id, name, size = 36, badge }: { id: string; name: string; size?: number; badge?: number | boolean }) {
  const [, force] = useState(0)
  const gen = useStore((s) => s.connGen)
  const showImg = failed.get(id) !== gen
  const src = `zap://avatar/${encodeURIComponent(id)}` + (failed.has(id) ? `?r=${gen}` : '')
  const color = colorOf(id)
  return (
    <div className="avatar" style={{ width: size, height: size, ['--c' as string]: color, fontSize: size * 0.36 }}>
      <div className="avatar-blob">
        <span>{initials(name)}</span>
      </div>
      {showImg && (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className={loaded.has(id) ? 'in' : ''}
          onLoad={(e) => {
            loaded.add(id)
            e.currentTarget.classList.add('in')
          }}
          onError={() => {
            failed.set(id, gen)
            force((n) => n + 1)
          }}
        />
      )}
      {!!badge && <i className="avatar-badge">{typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : ''}</i>}
    </div>
  )
})
