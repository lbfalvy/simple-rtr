import { variable, AsyncVariable, Variable, AsyncEmit, Lock } from "@lbfalvy/mini-events"
import jwtDecode from "jwt-decode"
import { Time } from "mockable-timer"

/**
 * A token pair as obtained from the authentication or refresh endpoint in RTR
 */
export interface TokenPair {
    /**
     * Auth token, accessible using `service.token`
     */
    auth: string,
    /**
     * Refresh token, not accessible from the outside but used for renewal
     */
    refresh: string
}

/**
 * Configuration options for the RTR agent
 */
export interface RtrConfig {
    /**
     * Refresh this much before expiry (seconds)
     */
    renewOnTtl: number
    /**
     * Retries this frequently if refresh fails (seconds)
     */
    lockExpiry: number
    /**
     * A tuple of a setter and a struct of a getter and a change event, which matches the return value
     * of `variable` from `@lbfalvy/mini-events`. Don't put a variable in it though, instead, connect the
     * appropriate functions to localStorage or some other shared state
     */
    storage: [AsyncEmit<[State|undefined]>, AsyncVariable<State|undefined>, Lock<State|undefined>]
    /**
     * Time API
     */
    time: Time
    /**
     * Obtain a token pair using a refresh token, return 'invalid' if the refresh token is invalid
     * or throw if the network or other circumstances prevent renewal
     */
    refresh: (refreshToken: string) => Promise<TokenPair|'invalid'>
    /**
     * Debug output
     */
    log?: (...args: any[]) => void // Debug output
}

/**
 * RTR agent interface
 */
export interface RtrAgent {
    /**
     * Call this on login, user switching and logout
     * @param pair Initial token pair
     */
    setPair(pair?: TokenPair | undefined): Promise<void>
    /**
     * Refresh the token pair for external reasons.
     */
    forceRefresh(): Promise<void>
    /**
     * Access the auth token
     */
    session: Variable<Variable<string> | undefined>
    /**
     * Unique random delay applied to all wait times to prevent thundering herd situations.
     */
    uniqueDelay: number
}

export type State = {
    pair: TokenPair,
    lockedAt?: number
}

function exp(token: { exp?: number }): number {
    if (!token.exp) return Infinity 
    return token.exp
}

function decodeToken<T>(token: string): (T & { exp?: number }) {
    try {
        return jwtDecode<T>(token)
    } catch(e) {
        console.error(e)
        console.error('Offending token:', token)
        throw e
    }
}

export class AssertionError extends Error {
    constructor(message?: string | undefined) {
        super(message)
    }
}

/**
 * Function that launches token renew flow
 * @param opts Delegates and configuration
 * @returns A function that always returns a valid token
 */
export function rtrAgent(opts: RtrConfig): RtrAgent {
    const { refresh, storage, renewOnTtl, lockExpiry, log, time } = opts
    const [ write, { get, changed }, lock] = storage
    let loop = false
    // Prevent thundering herd
    const uniqueDelay = Math.floor(Math.random() * 1000) / 1000
    /**
     * A state machine running concurrently in all tabs.
     * Principles:
     * - State may be read at any moment
     * --> continuous
     * - The whole machine may spontaneously halt and resume operation shortly or much later
     * --> timing resistant
     * - Network requests should be appropriately spaced and never repeated
     * --> locking
     * - Any single instance may spontaneously exit without cleanup
     * --> no SPOF
     */
    async function mainloop() {
        log?.(`Initializing authentication service with a unique delay of ${uniqueDelay}`)
        if (loop) throw new Error('Tried to launch second loop!')
        loop = true
        await Promise.resolve()
        try {
            while (loop) {
                const [release, state] = await lock()
                log?.('Current state:', state)
                // Initial, logged-out state
                if (!state) {
                    log?.('State empty, waiting for login...')
                    release()
                    await new Promise<any>(r => changed(r, true, true))
                    continue
                }
                const refreshToken = decodeToken(state.pair.refresh)
                log?.('Refresh token expires at', refreshToken.exp)
                // Session expired > transition to logged-out
                if (exp(refreshToken) - time.now() < 0) {
                    log?.('Session expired, clearing state...')
                    await write(undefined)
                    release()
                    continue
                }
                const auth = decodeToken(state.pair.auth)
                log?.('Access token expires at', auth.exp)
                // Pending request > wait for timeout, then transition if it didn't already
                // can transition to stale token or expired session
                if (state.lockedAt) {
                    if (time.now() < state.lockedAt) {
                        // logged for exact event ordering
                        log?.('Time travel detected, terminating')
                        await write(undefined)
                        release()
                        throw new Error('Time travel detected, terminating')
                    }
                    const unlockIn = time.now() - state.lockedAt + lockExpiry
                    if (0 < unlockIn) {
                        log?.(`Waiting ${unlockIn + uniqueDelay} for pending request to expire...`)
                        release()
                        await new Promise<void>(res => time.wait(unlockIn + uniqueDelay, res))
                        const [release2, newState] = await lock()
                        if (newState?.lockedAt === state.lockedAt) {
                            log?.('Pending request expired, clearing timeout...')
                            await write({ pair: state.pair })
                        }
                        release2()
                        continue
                    }
                }
                // stale token > transition to pending request
                // then try refreshing the token
                // then transition to fresh token state if it didn't already
                const renewIn = (exp(auth) - renewOnTtl - time.now())
                if (renewIn < 0) {
                    const lockedAt = time.now()
                    if (state?.lockedAt) {
                        release()
                        continue
                    }
                    log?.(`Stale access token, locking for renewal at ${lockedAt}...`)
                    await write({ ...state, lockedAt })
                    log?.('Value after write:', await get())
                    release()
                    try {
                        const result = await refresh(state.pair.refresh)
                        log?.('Refresh returned', result)
                        if (result === undefined) {
                            throw new AssertionError(
                                'ERROR: The token refresh callback returned undefined.\n' +
                                'Please make sure that this function either returns a token pair, ' +
                                'the string literal "invalid" or throws in the case of a network error.'
                            )
                        }
                        if (result == 'invalid') {
                            log?.('Invalid refresh token, clearing state')
                            const [release] = await lock()
                            await write(undefined)
                            release()
                            continue
                        }
                        const [release, newState] = await lock()
                        if (newState?.lockedAt !== lockedAt) {
                            await write(undefined)
                            release()
                            throw new AssertionError(
                                'Lock broken.\n' +
                                'This implies that something other than the RTR library ' +
                                'accessed the state.\n' +
                                'According to RTR rules, the session is now invalid.'
                            )
                        }
                        log?.('Saving new pair and unlocking...')
                        await write({ pair: result })
                        release()
                    } catch(ex) {
                        if (ex instanceof AssertionError) throw ex
                        log?.('Encountered error', ex)
                        log?.('Failed to refresh, lock maintained...')
                    }
                    continue
                }
                // valid token > wait until renewal due
                // transition to stale token
                log?.(`Waiting ${renewIn + uniqueDelay} for access token to go stale...`)
                release()
                await new Promise<void>(res => time.wait(renewIn + uniqueDelay, res))
            }
        } catch(e) {
            loop = false
            throw e
        }
    }
    mainloop()
    async function createSession(): Promise<Variable<string>> {
        log?.('Constructing new session')
        const state = await get()
        if (!state) throw new Error('No active token')
        const [set, v] = variable<string>(state.pair.auth)
        const dispose = changed((fresh, old) => {
            if (fresh && old && fresh.pair.auth === old.pair.auth) return
            log?.('updating token string:', fresh)
            if (fresh === undefined) dispose()
            else set(fresh.pair.auth)
        }, true)
        return v
    }
    const [setSession, session] = variable<Variable<string>>()
    const dispose = changed(async (fresh, old) => {
        log?.('storage event old:', old, 'fresh:', fresh)
        if (!old) setSession(await createSession())
        if (!fresh) setSession(undefined)
    })
    createSession()
        .then(tok => setSession(tok))
        .catch(() => {}) // TODO: only catch "No active token"
    const actions: RtrAgent = {
        async setPair(pair) {
            const [release] = await lock()
            if (pair) {
                await write({ pair })
                if (!loop) mainloop()
            } else { await write(undefined) }
            release()
        },
        async forceRefresh() {
            const [release, state] = await lock()
            if (!state) throw new Error('use setPair')
            const lockedAt = time.now()
            await write({ ...state, lockedAt })
            const result = await refresh(state.pair.refresh)
            if (result == 'invalid') {
                log?.('Invalid refresh token, clearing state')
                await write(undefined)
                release()
                return
            }
            const newState = await get()
            if (newState?.lockedAt !== lockedAt) throw new AssertionError('Lock broken')
            await write({ pair: result })
            release()
        },
        uniqueDelay,
        session
    }
    return actions
}
