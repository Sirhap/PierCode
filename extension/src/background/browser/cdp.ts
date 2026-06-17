// CDP command wrappers. Mirror controller_ext.go runtimeEvaluate / callFunctionOn
// + a thin sendCommand. Takes an injected low-level `send` for testability.
type Debuggee = chrome.debugger.Debuggee
type SendFn = (target: Debuggee, method: string, params?: object) => Promise<any>

const defaultSend: SendFn = (t, m, p) => chrome.debugger.sendCommand(t, m, p ?? {})

export interface Cdp {
  sendCommand(target: Debuggee, domain: string, method: string, params?: object): Promise<any>
  runtimeEvaluate(target: Debuggee, expression: string): Promise<any>
  callFunctionOnObject(target: Debuggee, objectId: string, fnDecl: string, args?: any[]): Promise<any>
}

export function makeCdp(send: SendFn = defaultSend): Cdp {
  return {
    async sendCommand(target, domain, method, params) {
      return send(target, `${domain}.${method}`, params ?? {})
    },
    async runtimeEvaluate(target, expression) {
      const out = await send(target, 'Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      })
      if (out?.exceptionDetails) {
        throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'evaluate failed')
      }
      return out?.result?.value
    },
    async callFunctionOnObject(target, objectId, fnDecl, args = []) {
      const out = await send(target, 'Runtime.callFunctionOn', {
        objectId, functionDeclaration: fnDecl, returnByValue: true, awaitPromise: true,
        arguments: args.map(v => ({ value: v })),
      })
      if (out?.exceptionDetails) {
        throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'callFunctionOn failed')
      }
      return out?.result?.value
    },
  }
}

// Module-level default instance for production use.
export const cdp = makeCdp()
