import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { parseWorkingHours } from './utils';

interface Props {
  startHour: number;
  endHour: number;
  onCommit(hours: { startHour: number; endHour: number }): void;
}

/** Keeps typed drafts local; the saved hours change only on blur or Enter, when the pair is valid. */
export function WorkingHoursFields({ startHour, endHour, onCommit }: Props) {
  const [startDraft, setStartDraft] = useState(String(startHour));
  const [endDraft, setEndDraft] = useState(String(endHour));
  const [error, setError] = useState<{ field: 'start' | 'end'; message: string } | null>(null);
  // A saved value can arrive after the user resumes typing; it must not replace that newer draft.
  const editing = useRef(false);

  useEffect(() => { if (!editing.current) { setStartDraft(String(startHour)); setEndDraft(String(endHour)); setError(null); } }, [startHour, endHour]);

  function edit(set: (value: string) => void) { return (event: ChangeEvent<HTMLInputElement>) => { editing.current = true; set(event.target.value); }; }

  function commit() {
    const result = parseWorkingHours(startDraft, endDraft);
    if (!result.ok) { setError({ field: result.field, message: result.message }); return; }
    editing.current = false;
    setError(null);
    if (result.startHour !== startHour || result.endHour !== endHour) onCommit({ startHour: result.startHour, endHour: result.endHour });
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') { editing.current = false; setStartDraft(String(startHour)); setEndDraft(String(endHour)); setError(null); }
  }

  return <>
    <label>Start<input aria-label="Start hour" aria-invalid={error?.field === 'start'} aria-describedby="working-hours-hint" type="number" inputMode="numeric" min="0" max="23" step="1" value={startDraft} onChange={edit(setStartDraft)} onBlur={commit} onKeyDown={handleKey} /></label>
    <label>End<input aria-label="End hour" aria-invalid={error?.field === 'end'} aria-describedby="working-hours-hint" type="number" inputMode="numeric" min="1" max="24" step="1" value={endDraft} onChange={edit(setEndDraft)} onBlur={commit} onKeyDown={handleKey} /></label>
    <small id="working-hours-hint" className={error ? 'working-hours-hint form-error' : 'working-hours-hint'} role={error ? 'alert' : undefined}>{error?.message ?? 'Hours use a 24-hour clock. Changes save when you leave a field or press Enter.'}</small>
  </>;
}
