# revpack

revpack prepares local review bundles for coding agents and lets people decide which agent outputs are published back to the review target.

## Language

### Review Workflow

**Review Target**:
A pull request, merge request, or local branch range that revpack prepares for review.
_Avoid_: Change request, review subject

**Prepare**:
The action of creating or refreshing a review bundle for a review target without producing or publishing review material.
_Avoid_: Generate, build, fetch

**Checkout**:
The action of making a review target available in the local repository and preparing its review bundle.
_Avoid_: Clone, switch, fetch

**Review Bundle**:
A disposable local package of review context created for a review target so an agent can review with the relevant diff, discussion, and instructions.
_Avoid_: Context folder, workspace, review package

**Publish**:
The intentional action of applying agent output back to the review target through its provider.
_Avoid_: Post, submit, send, upload

**Guided Publish**:
An interactive publish flow that summarizes publishable review material before asking which items to publish.
_Avoid_: Publish all, auto-publish

**Checkpoint**:
A published marker of the review target state that future prepares use to decide what changed since the last intentional review.
_Avoid_: Baseline, snapshot, save point

**Incremental Review**:
A review pass focused on changes since the last checkpoint rather than the entire review target.
_Avoid_: Follow-up review, delta review

**Local Review**:
A review of committed local branch changes before a pull request or merge request exists.
_Avoid_: Offline review, branch review

### Review Material

**Agent Output**:
Draft review material written by an agent for later inspection and publishing.
_Avoid_: Bot comment, generated result

**Finding**:
A new agent-proposed line comment about code changed in the review target. A finding must have a valid positional anchor.
_Avoid_: Issue, defect, annotation

**Positional Anchor**:
The valid diff position where a finding can be published on a review target.
_Avoid_: Anchor, line number, file location

**Reply**:
An agent-proposed, publishable response to an existing review thread.
_Avoid_: Response, answer, follow-up comment

**Review Thread**:
A provider discussion attached to the review target, usually anchored to a changed line but sometimes general. Some providers represent a review thread as a top-level comment with replies.
_Avoid_: Discussion, conversation, comment thread

**Review Note**:
A visible target-level review comment that is not anchored to a specific line or existing thread.
_Avoid_: General comment, review body

**Summary**:
A target description section maintained by revpack to summarize the reviewed changes.
_Avoid_: Description, overview

### Configuration and Agent Setup

**Provider**:
The system revpack reads review data from and publishes review material back to, including hosted code review services and local Git.
_Avoid_: Integration, host, backend

**Profile**:
A named set of provider settings used to connect revpack to a repository workflow. A profile references credentials but is not itself a credential.
_Avoid_: Account, configuration, credential set

**Credential Reference**:
A profile field that names where revpack can read a credential at runtime without storing the credential value.
_Avoid_: Credential, secret, token value

**Provider Authentication**:
The provider access setup represented by a profile and its credential references. Revpack stores the references, not provider credential values.
_Avoid_: Login, token storage, connection

**Review Guidance**:
Project-specific review priorities that agents should follow when reviewing a review bundle.
_Avoid_: Instructions, contract, prompt

**Agent Instruction**:
A project-level artifact that tells a specific agent how to start and perform a revpack review.
_Avoid_: Harness, adapter, integration, prompt
