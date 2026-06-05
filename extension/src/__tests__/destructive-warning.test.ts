import { describe, it, expect } from 'vitest';
import { getDestructiveCommandWarning } from '../content/destructive-warning';

describe('getDestructiveCommandWarning', () => {
  it('returns null for safe commands', () => {
    expect(getDestructiveCommandWarning('ls -la')).toBeNull();
    expect(getDestructiveCommandWarning('git status')).toBeNull();
    expect(getDestructiveCommandWarning('go test ./...')).toBeNull();
    expect(getDestructiveCommandWarning('')).toBeNull();
    expect(getDestructiveCommandWarning('git commit -m "fix"')).toBeNull();
  });

  it('warns on git reset --hard', () => {
    expect(getDestructiveCommandWarning('git reset --hard HEAD~1')).toContain('未提交');
  });

  it('warns on force push', () => {
    expect(getDestructiveCommandWarning('git push --force origin main')).toContain('远程');
    expect(getDestructiveCommandWarning('git push -f')).toContain('远程');
    expect(getDestructiveCommandWarning('git push --force-with-lease')).toContain('远程');
  });

  it('warns on rm -rf with strongest matching note', () => {
    expect(getDestructiveCommandWarning('rm -rf build/')).toContain('递归强制');
    expect(getDestructiveCommandWarning('rm -r dir')).toContain('递归');
    expect(getDestructiveCommandWarning('rm -f file')).toContain('强制');
  });

  it('warns on database destructive SQL', () => {
    expect(getDestructiveCommandWarning('psql -c "DROP TABLE users"')).toContain('数据库');
    expect(getDestructiveCommandWarning('DELETE FROM users;')).toContain('删除整张表');
  });

  it('warns on --no-verify hook bypass', () => {
    expect(getDestructiveCommandWarning('git commit --no-verify -m x')).toContain('钩子');
  });

  it('warns on infra destroy', () => {
    expect(getDestructiveCommandWarning('terraform destroy')).toContain('Terraform');
    expect(getDestructiveCommandWarning('kubectl delete pod foo')).toContain('Kubernetes');
  });

  it('does not warn on git clean dry-run', () => {
    expect(getDestructiveCommandWarning('git clean -n -d')).toBeNull();
    expect(getDestructiveCommandWarning('git clean --dry-run')).toBeNull();
  });

  it('warns on git clean force', () => {
    expect(getDestructiveCommandWarning('git clean -fd')).toContain('未跟踪');
  });
});
