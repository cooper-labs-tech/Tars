import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { blankMember, branchSlug } from '@/components/NewChatModal/team-defaults';

describe('blankMember', () => {
  it('numbers the new row instead of guessing a role', () => {
    const m = blankMember(2);
    expect(m.name).toBe('Member 3');
  });

  it('is a claude/auto agent with no skills, so the row deploys as-is', () => {
    const m = blankMember(0);
    expect(m.provider).toBe('claude');
    expect(m.permissionMode).toBe('auto');
    expect(m.skills).toEqual([]);
  });
});

describe('branchSlug', () => {
  it('slugifies a role name into a feature branch', () => {
    expect(branchSlug('Frontend Engineer')).toBe('feat/frontend-engineer');
  });

  it('collapses punctuation and repeated separators', () => {
    expect(branchSlug('QA / Audit  Engineer!!')).toBe('feat/qa-audit-engineer');
  });

  it('is blank for a blank name, so it never overwrites a real branch with "feat/"', () => {
    expect(branchSlug('   ')).toBe('');
  });
});
