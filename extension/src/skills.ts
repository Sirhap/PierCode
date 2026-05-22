export type SkillSummary = {
  name: string;
  description: string;
};

export function isBuiltInPierCodeSkill(skill: SkillSummary): boolean {
  return skill.name.trim().toLowerCase().startsWith('piercode-');
}

export function filterUserVisibleSkills(skills: SkillSummary[]): SkillSummary[] {
  return skills.filter(skill => !isBuiltInPierCodeSkill(skill));
}
