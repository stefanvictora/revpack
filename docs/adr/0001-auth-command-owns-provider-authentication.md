# Auth Command Owns Provider Authentication

Provider authentication setup and verification should have one canonical CLI surface. Revpack uses `auth` for provider authentication workflows and removes duplicate `connect`, `config setup`, and `config doctor` spellings before release, keeping `config` focused on lower-level profile inspection and editing. This favors a smaller, clearer command surface over compatibility with pre-release or older onboarding aliases.
