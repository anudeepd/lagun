// Single source of truth for the keyboard shortcuts the app implements.
//
// The `?` help sheet (`components/ui/ShortcutHelpDialog.tsx`) renders from this
// list, so the sheet cannot drift from the code. Every entry below was verified
// against the handler that implements it — the comment above each group names
// that handler. Editor (run query) → Grid → Navigation → General is also the
// order the sheet renders its sections in.

export type ShortcutGroup = 'Editor' | 'Grid' | 'Navigation' | 'General'

export interface Shortcut {
  /** Keys to press, one chip per entry — e.g. `['Ctrl/Cmd', 'K']`. */
  keys: string[]
  /** What the shortcut does. */
  label: string
  /** Sheet section. Groups render in the order they first appear here. */
  group: ShortcutGroup
}

export const SHORTCUTS: readonly Shortcut[] = [
  // components/editor/QueryEditor.tsx — `runKeymap` (Ctrl-Enter / mac Cmd-Enter)
  { keys: ['Ctrl/Cmd', 'Enter'], label: 'Run query', group: 'Editor' },

  // components/editor/ResultGrid.tsx — window capture handler (`:570` Ctrl/Cmd+F,
  // `:586` Ctrl/Cmd+C, `:592` Shift+Enter) and the find-bar navigation handler
  // (`:627` Enter / `:630` Shift+Enter), primary path in GridSearchBar.tsx `:69`.
  { keys: ['Ctrl/Cmd', 'F'], label: 'Find in results', group: 'Grid' },
  { keys: ['Enter'], label: 'Next find match (find bar open)', group: 'Grid' },
  { keys: ['Shift', 'Enter'], label: 'Previous find match (find bar open)', group: 'Grid' },
  { keys: ['Shift', 'Enter'], label: 'Open large cell editor (focused cell)', group: 'Grid' },
  { keys: ['Ctrl/Cmd', 'C'], label: 'Copy focused cell value', group: 'Grid' },

  // components/layout/TabBar.tsx — `handleTabKeyDown` (`:74`/`:75` arrows, `:76`/`:77` Home/End)
  { keys: ['Arrow Left', 'Arrow Right'], label: 'Switch tabs when the tab bar is focused', group: 'Navigation' },
  { keys: ['Home', 'End'], label: 'First or last tab when the tab bar is focused', group: 'Navigation' },

  // components/layout/AppLayout.tsx — window keydown (`:31` palette, `:35` help)
  { keys: ['Ctrl/Cmd', 'K'], label: 'Open command palette', group: 'General' },
  // components/ui/Modal.tsx `:103`, Select.tsx `:47`, LimitSelect.tsx `:29`,
  // hooks/useMenuKeyboard.ts `:21`, GridSearchBar.tsx `:66`
  { keys: ['Escape'], label: 'Close dialog, menu or find bar', group: 'General' },
  { keys: ['?'], label: 'Open this help', group: 'General' },
]
