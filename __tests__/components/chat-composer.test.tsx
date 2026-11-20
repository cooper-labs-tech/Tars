import '../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, elements, ofType, textOf, type Mount } from './hook-runtime';
import { RoomComposer, type ComposerTarget } from '../../src/components/Chat/RoomComposer';
import { ComposerCard } from '../../src/components/ui/ComposerCard';
import { MenuPicker } from '../../src/components/ui/MenuPicker';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Chat composer of #124, pinned at its QA gate: what the room's card says
 * and allows in each state the backend has today, the Enter rule of the card,
 * and the menu's keyboard. Each test here was seen to fail on a mutant of the
 * behaviour it names.
 */

type Props = Parameters<typeof RoomComposer>[0];
type CardProps = Parameters<typeof ComposerCard>[0];
type El = { props: Record<string, unknown> };

let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

const target = (over: Partial<ComposerTarget> & { id: string }): ComposerTarget => ({
  label: over.id, busy: false, noTurnSignal: false, canInterrupt: false, stopped: false, tone: 'idle', state: 'idle', ...over,
});

describe('the room composer', () => {
  let props: Props;
  const open = (over: Partial<Props> = {}) => {
    props = {
      value: 'hello', onChange: () => {}, onSend: vi.fn(), onTargetChange: () => {}, roomTitle: 'tars', targetId: '',
      targets: [target({ id: 'a1', label: 'Backend' }), target({ id: 'a2', label: 'QA' })],
      ...over,
    };
    page = mount(() => RoomComposer(props));
  };
  const rerender = (over: Partial<Props>) => { Object.assign(props, over); page!.rerender(); };
  const card = () => (ofType(page!.result, ComposerCard)[0] as unknown as El).props as unknown as CardProps;
  const strip = () => card().notice?.text ?? null;
  const button = (word: string) => (elements(card().notice?.actions) as unknown as El[])
    .find(el => textOf(el.props.children as never) === word);
  const click = (word: string) => (button(word)!.props.onClick as () => void)();

  it('says one thing at a time: a failure, everyone stopped, the stopped target, held, queued, then nothing', () => {
    open({ targets: [target({ id: 'a1', label: 'Backend', stopped: true }), target({ id: 'a2', label: 'QA', stopped: true })], failure: { kind: 'send', message: 'Failed to post' } });
    // The room's own sentence, the frame's: the main process's is not relayed.
    expect(strip()).toBe('Not sent: the room did not accept the message. Your text is still here; press send to try again.');
    rerender({ failure: null });
    expect(strip()).toBe('Everyone in tars is stopped. Nothing you write reaches an agent until one starts.');
    rerender({ targets: [target({ id: 'a1', label: 'Backend', stopped: true }), target({ id: 'a2', label: 'QA' })], targetId: 'a1' });
    expect(strip()).toBe('Backend is stopped. Nothing you write reaches it until it starts.');
    // An agent with no turn signal is held even while it reads as busy.
    rerender({ targets: [target({ id: 'a1', label: 'Backend', busy: true, noTurnSignal: true })] });
    expect(strip()).toBe('Backend never says when its turn ends, so this message is held until you send it on.');
    rerender({ targets: [target({ id: 'a1', label: 'Backend', busy: true })] });
    expect(strip()).toBe('Backend is working, so this message will wait in its queue until the turn ends.');
    rerender({ targets: [target({ id: 'a1', label: 'Backend' })] });
    expect(strip()).toBeNull();
  });

  it('lets send act only with text, a recipient that can receive it, and nothing in flight', () => {
    open();
    expect(card().canSubmit).toBe(true);
    rerender({ value: '   ' });
    expect(card().canSubmit).toBe(false);
    rerender({ value: 'hello', sending: true });
    expect(card().canSubmit).toBe(false);
    rerender({ sending: false, targets: [target({ id: 'a1', stopped: true }), target({ id: 'a2' })], targetId: 'a1' });
    expect(card().canSubmit).toBe(false);
    rerender({ targets: [target({ id: 'a1', stopped: true })], targetId: '' });
    expect(card().canSubmit).toBe(false);
    expect(card().placeholder).toBe('Start an agent to write here');
  });

  it('starts exactly the stopped agents it names, and not again while they start', () => {
    const onStart = vi.fn();
    open({ onStart, targets: [target({ id: 'a1', stopped: true }), target({ id: 'a2', stopped: true })] });
    click('start all');
    expect(onStart).toHaveBeenLastCalledWith(['a1', 'a2']);
    rerender({ targets: [target({ id: 'a1', stopped: true }), target({ id: 'a2' })], targetId: 'a1' });
    click('start');
    expect(onStart).toHaveBeenLastCalledWith(['a1']);
    rerender({ starting: true });
    expect(button('starting')!.props.disabled).toBe(true);
  });

  // Since #169 the bus interrupts a turn, for a CLI that can be (`canInterrupt`).
  // One that cannot gets the queue, and no button that could never work.
  it('offers send now only for an agent whose turn Tars can interrupt', () => {
    const onSendNow = vi.fn();
    open({ onSendNow, targets: [target({ id: 'a1', label: 'Backend', busy: true })], targetId: 'a1' });
    expect(button('send now')).toBeUndefined();
    expect(strip()).toBe('Backend is working, so this message will wait in its queue until the turn ends.');
    rerender({ targets: [target({ id: 'a1', label: 'Backend', busy: true, canInterrupt: true })] });
    expect(button('send now')!.props.disabled).toBe(false);
    expect(strip()).toBe('Backend is working, so this message will wait in its queue until the turn ends. Send now interrupts that turn.');
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it('asks once before send now interrupts, and the question lapses for another recipient or no text', () => {
    const onSendNow = vi.fn();
    const onSend = vi.fn();
    open({ onSendNow, onSend, targets: [target({ id: 'a1', label: 'Backend', busy: true, canInterrupt: true }), target({ id: 'a2', label: 'QA', busy: true, canInterrupt: true })], targetId: 'a1' });
    click('send now');
    expect(strip()).toBe("Interrupt Backend's turn and send this now? What it is doing stops where it is.");
    expect(card().canSubmit).toBe(false);
    click('cancel');
    expect(strip()).toMatch(/^Backend is working/);
    expect(onSendNow).not.toHaveBeenCalled();

    click('send now');
    click('interrupt and send');
    expect(onSendNow).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    click('send now');
    rerender({ targetId: 'a2' });
    expect(strip()).toMatch(/^QA is working/);
    rerender({ targetId: 'a1', value: '' });
    expect(strip()).toMatch(/^Backend is working/);
  });
});

describe('the card', () => {
  const cardWith = (canSubmit: boolean) => {
    const onSubmit = vi.fn();
    page = mount(() => ComposerCard({ value: 'hi', onChange: () => {}, onSubmit, placeholder: 'Write', canSubmit, submitLabel: 'Send' }));
    const press = (e: object) => ((ofType(page!.result, 'textarea')[0] as unknown as El).props.onKeyDown as (e: unknown) => void)(
      { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {}, ...e });
    return { onSubmit, press };
  };

  it('sends on Enter only when send can act, never with Shift, never while an input method composes', () => {
    const on = cardWith(true);
    on.press({ shiftKey: true });
    on.press({ nativeEvent: { isComposing: true } });
    expect(on.onSubmit).not.toHaveBeenCalled();
    on.press({});
    expect(on.onSubmit).toHaveBeenCalledTimes(1);
    page!.unmount();

    const off = cardWith(false);
    off.press({});
    expect(off.onSubmit).not.toHaveBeenCalled();
  });
});

describe('the menu picker', () => {
  const OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
  const picker = (value: string, options: { value: string; label: string; disabled?: boolean }[] = OPTIONS) => {
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const onChange = vi.fn();
    page = mount(() => MenuPicker({ value, options, onChange, ariaLabel: 'Who this message is for' }));
    const key = (k: string) => ((elements(page!.result) as unknown as El[]).find(el => typeof el.props.onKeyDown === 'function')!
      .props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault() {}, stopPropagation() {} });
    return { onChange, key };
  };

  it('moves the first arrow after opening from the current choice, not from the first row', () => {
    const { onChange, key } = picker('b');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  // F1 of the gate of #124. Chromium sends a mouseenter and a mousemove at one
  // spot when the panel opens under a pointer at rest; a real move reports
  // another spot.
  const rowAt = (index: number) => (elements(page!.result) as unknown as El[])
    .find(el => el.props.role === 'option' && el.props['data-index'] === index)!;
  // Whichever of the two a row listens to: the pair Chromium sends at rest.
  const pointerOn = (index: number, screenX: number, screenY: number) => {
    (rowAt(index).props.onMouseEnter as ((e: unknown) => void) | undefined)?.({ screenX, screenY });
    (rowAt(index).props.onMouseMove as ((e: unknown) => void) | undefined)?.({ screenX, screenY });
  };
  const lit = () => (elements(page!.result) as unknown as El[])
    .filter(el => el.props.role === 'option' && String(el.props.className).includes('bg-secondary'))
    .map(el => el.props['data-index']);

  it('keeps the keys on the current choice when the menu opens under a pointer at rest', () => {
    const { onChange, key } = picker('a');
    key('ArrowDown');
    pointerOn(2, 400, 300);
    key('ArrowDown');
    key('Enter');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('lets a pointer that really moves take the highlight, and lights one row only', () => {
    const { onChange, key } = picker('a');
    key('ArrowDown');
    expect(lit()).toEqual([0]);
    pointerOn(2, 400, 300);
    expect(lit()).toEqual([0]);
    (rowAt(2).props.onMouseMove as (e: unknown) => void)({ screenX: 401, screenY: 304 });
    // C takes the fill; A, the current choice, keeps its check and not the fill.
    expect(lit()).toEqual([2]);
    expect(rowAt(0).props['aria-selected']).toBe(true);
    key('Enter');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('steps over a disabled row, and Escape closes without a change', () => {
    const { onChange, key } = picker('a', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]);
    key('ArrowDown');
    key('ArrowDown');
    key('Escape');
    expect(onChange).not.toHaveBeenCalled();
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(onChange).toHaveBeenCalledWith('c');
  });
});
