// Single shared ApprovalManager instance for the SW. The controller's gates call
// approval.ask(); the runtime onMessage handler routes BROWSER_APPROVAL_ANSWER into
// approval.deliver(). Kept in its own module so both sides import the same instance
// without a controller↔index cycle.
import { ApprovalManager } from './approval'

export const approval = new ApprovalManager()
