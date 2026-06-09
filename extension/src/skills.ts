export type SkillSummary = {
  name: string;
  description: string;
};

// PierCode's own skills are namespaced `piercode-*` and are internal plumbing
// (self-dev, code-review, …), not something the user invokes from the slash
// picker. Hide them so user-created skills stay prominent.
export function isPierCodeSkill(skill: SkillSummary): boolean {
  return skill.name.trim().toLowerCase().startsWith('piercode-');
}

export function filterUserVisibleSkills(skills: SkillSummary[]): SkillSummary[] {
  return skills.filter(skill => !isPierCodeSkill(skill));
}
