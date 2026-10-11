import { describe, it, expect } from 'vitest';
import { localNameFor, registeredCardStep, newCardMode, regularCustomerStep } from './customerName';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('localNameFor — the app’s own name, only for the same person', () => {
  it('uses the saved name of the same identity', () => {
    expect(localNameFor({ hex_id: A, display_name: ' Ana Novak ' }, A)).toBe('Ana Novak');
  });
  it('ignores a name saved under a different identity', () => {
    expect(localNameFor({ hex_id: B, display_name: 'Someone Else' }, A)).toBe('');
  });
  it('nothing saved → no name', () => {
    expect(localNameFor(null, A)).toBe('');
    expect(localNameFor({ hex_id: A, display_name: null }, A)).toBe('');
  });
});

describe('registeredCardStep — a registered card with no local name', () => {
  it('Živa center, 8 Oct 2026: no profile anywhere, own key scanned → ask for the name', () => {
    expect(registeredCardStep({ status: 'absent' }, A, A)).toEqual({ action: 'askName' });
  });
  it('a profile exists → its name goes on the sale, nothing is asked or written', () => {
    expect(registeredCardStep({ status: 'found', name: 'Ana Novak' }, A, A)).toEqual({ action: 'sell', name: 'Ana Novak' });
  });
  it('a profile without a name is not overwritten', () => {
    expect(registeredCardStep({ status: 'found', name: null }, A, A)).toEqual({ action: 'sell', name: '' });
  });
  it('a relay did not answer → sells as before, never asks', () => {
    expect(registeredCardStep({ status: 'unknown' }, A, A)).toEqual({ action: 'sell', name: '' });
  });
  it('a secondary wallet (scanned key is not the identity) → cannot sign that profile, sells as before', () => {
    expect(registeredCardStep({ status: 'absent' }, B, A)).toEqual({ action: 'sell', name: '' });
  });
  it('a wallet address, no key scanned → never asks', () => {
    expect(registeredCardStep({ status: 'absent' }, null, A)).toEqual({ action: 'sell', name: '' });
  });
});

describe('newCardMode — a card that is not registered yet', () => {
  it('a profile already exists for the key → keep it, register only', () => {
    expect(newCardMode({ status: 'found', name: 'Ana Novak' })).toEqual({ mode: 'keepProfile', name: 'Ana Novak' });
  });
  it('no profile, or relays did not answer → write it, as before', () => {
    expect(newCardMode({ status: 'absent' })).toEqual({ mode: 'new' });
    expect(newCardMode({ status: 'unknown' })).toEqual({ mode: 'new' });
  });
});

describe('regularCustomerStep — tapping a regular customer', () => {
  it('a saved name sells with it, no lookup needed', () => {
    expect(regularCustomerStep('Ana Novak', null)).toEqual({ action: 'sell', name: 'Ana Novak' });
  });
  it('no saved name but a profile name → sells with it', () => {
    expect(regularCustomerStep(null, { status: 'found', name: 'Ana Novak' })).toEqual({ action: 'sell', name: 'Ana Novak' });
  });
  it('confirmed no profile → the card must be scanned (that asks for the name)', () => {
    expect(regularCustomerStep('  ', { status: 'absent' })).toEqual({ action: 'scanCard' });
  });
  it('a relay did not answer → sells as before', () => {
    expect(regularCustomerStep(null, { status: 'unknown' })).toEqual({ action: 'sell', name: '' });
  });
});
