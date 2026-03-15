interface GridCell {
  label: string
  x: number
  y: number
}

const GRID_CELLS: GridCell[] = [
  { label: 'TL', x: 0.1, y: 0.1 },
  { label: 'TC', x: 0.5, y: 0.1 },
  { label: 'TR', x: 0.9, y: 0.1 },
  { label: 'ML', x: 0.1, y: 0.5 },
  { label: 'C',  x: 0.5, y: 0.5 },
  { label: 'MR', x: 0.9, y: 0.5 },
  { label: 'BL', x: 0.1, y: 0.85 },
  { label: 'BC', x: 0.5, y: 0.85 },
  { label: 'BR', x: 0.9, y: 0.85 },
]

interface Props {
  positionX: number
  positionY: number
  onSelect: (x: number, y: number) => void
}

function nearestCell(px: number, py: number): GridCell {
  let best = GRID_CELLS[0]
  let bestDist = Infinity
  for (const cell of GRID_CELLS) {
    const dx = cell.x - px
    const dy = cell.y - py
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = cell
    }
  }
  return best
}

export default function SubtitlePositionGrid({ positionX, positionY, onSelect }: Props) {
  const active = nearestCell(positionX, positionY)

  return (
    <div className="flex flex-col gap-1">
      <label className="block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
        Position Grid
      </label>
      <div
        className="grid grid-cols-3 gap-0.5 rounded border border-[var(--border)] p-0.5"
        style={{ width: 81, height: 81 }}
        title="Click a cell to set subtitle position"
      >
        {GRID_CELLS.map((cell) => {
          const isActive = active.label === cell.label
          return (
            <button
              key={cell.label}
              title={`x:${cell.x} y:${cell.y}`}
              onClick={() => onSelect(cell.x, cell.y)}
              className={`flex items-center justify-center rounded text-[8px] font-bold transition ${
                isActive
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--primary)]/20 hover:text-[var(--foreground)]'
              }`}
              style={{ width: 25, height: 25 }}
            >
              {isActive ? '●' : '·'}
            </button>
          )
        })}
      </div>
    </div>
  )
}
