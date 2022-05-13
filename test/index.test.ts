import { RtrAgent, rtrAgent, RtrConfig, State, TokenPair  } from "../src";
import jwt from 'jsonwebtoken'
import { AsyncEmit, AsyncVariable, asyncVariable, Emit, Variable, variable, Lock } from "@lbfalvy/mini-events";
import { mockTime, Time, TimeManager } from "mockable-timer";
import { bufferedDispatch, CallOf, constant, thrower } from "buffered-dispatch";

describe('Reverse Token Rotation agent', () => {  
    var time!: Time
    var timeMgr!: TimeManager
    var refresh!: (s: string) => Promise<TokenPair|'invalid'>
    var servePair!: () => Promise<CallOf<typeof refresh>>
    var writeStorage!: AsyncEmit<[State|undefined]>
    var storage!: AsyncVariable<State|undefined>
    var lock!: Lock<State|undefined>
    var config!: RtrConfig
    var first!: RtrAgent, second!: RtrAgent
    
    const getDefaultPair = (
        authLife = 60 * 5,
        refreshLife = 60 * 60 * 5
    ): TokenPair => ({
        refresh: jwt.sign({ exp: time.now() + refreshLife }, 'shhhh'),
        auth: jwt.sign({ exp: time.now() + authLife }, 'shhhh')
    })
    
    beforeEach(() => {
        [writeStorage, storage, lock] = asyncVariable<State | undefined>();
        [time, timeMgr] = mockTime();
        [refresh, servePair] = bufferedDispatch<[string], TokenPair | 'invalid'>()
        const getLog = (tag: string) => (...args: any[]) => {
            console.log(time.now(), tag, ...args)
        }
        const _lock: typeof lock = async () => {
            const [release, data] = await lock()
            console.log('Lock acquired')
            return [
                () => {
                    console.log('Lock released')
                    release()
                },
                data
            ]
        }
        config = {
            time, refresh,
            storage: [writeStorage, storage, _lock],
            lockExpiry: 10, renewOnTtl: 60,
        }
        first = rtrAgent({ ...config, log: getLog('first:') })
        second = rtrAgent({ ...config, log: getLog('second:') })
        if (second.uniqueDelay < first.uniqueDelay) [second, first] = [first, second]
    })

    test('Can log in and out correctly', async () => {
        // Setup
        expect(first.session.get()).toBeUndefined()
        expect(await storage.get()).toBeUndefined()
        const onSession = jest.fn()
        first.session.changed(onSession, true)
        // Login
        await first.setPair(getDefaultPair());
        await timeMgr.flushMtq()
        const session = first.session.get()
        expect(session).toBeDefined()
        expect(onSession).toHaveBeenLastCalledWith(session, undefined)
        expect(second.session.get()).toBeDefined()
        // Logout
        await first.setPair(undefined)
        await timeMgr.flushMtq()
        expect(onSession).toHaveBeenLastCalledWith(undefined, session)
        expect(first.session.get()).toBeUndefined()
        expect(second.session.get()).toBeUndefined()
    })

    test('Refreshing is executed as expected', async () => {
        await second.setPair(getDefaultPair())
        await timeMgr.progressTo(4*60 + 1) // Wait until renewal is due
        expect(await storage.get()).toHaveProperty('lockedAt') // Verify that it's locked
        await servePair().then(constant(getDefaultPair())) // serve the first request
        // Verify that no second request is made
        const forbiddenFn = jest.fn()
        servePair().then(forbiddenFn)
        await timeMgr.progress(5)
        expect(forbiddenFn).not.toHaveBeenCalled()
        expect(await storage.get()).not.toHaveProperty('lockedAt') // Verify that the lock is released
    })

    test('Refreshing fails and is retried in a timely manner', async () => {
        await second.setPair(getDefaultPair())
        // Fail first request
        servePair().then(thrower(new Error('Something broke')))
        await timeMgr.progress(60 * 4 + 1)
        const secondRequest = jest.fn(constant(getDefaultPair()))
        servePair().then(secondRequest)
        // Wait within lock expiry
        await timeMgr.progress(5)
        expect(secondRequest).not.toHaveBeenCalled()
        // Wait until after lock expiry
        await timeMgr.progress(6)
        expect(secondRequest).toHaveBeenCalled()
    })

    test('The session is cleared if refresh yields invalid', async () => {
        await second.setPair(getDefaultPair())
        // Reject request
        servePair().then(constant('invalid'))
        await timeMgr.progress(4 * 60 + 2)
        console.log(timeMgr.getQueue())
        expect(first.session.get()).toBeUndefined()
    })

    test('The session is cleared on timeout', async () => {
        await first.setPair(getDefaultPair(5*60, 10*60))
        // renewOnTtl = 60, lockExpiry = 10
        // (refreshLife - accessLife + renewOnTtl) / lockExpiry
        // (10*60 - 5*60 + 60) / 10 = 36
        for (let i = 0; i < 36; i++) {
            servePair().then(thrower(new Error('Network unreachable')))
        }
        await timeMgr.progress(10 * 60 - 1)
        expect(await storage.get()).toBeDefined()
        // It takes up to lockExpiry + epsilon + uniqueDelay for the agents to conclude
        // that the final request failed
        await timeMgr.progress(12)
        console.log('Test ending at', time.now())
        expect(await storage.get()).toBeUndefined()
    })
})
