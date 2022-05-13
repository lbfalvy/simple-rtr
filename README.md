# Simple RTR

A simple but complete implementation of Refresh Token Rotation, with no
platform dependencies for maximum flexibility. The recommended
implementations of each dependency are marked as peer dependencies but
you're welcome to use your own storage and time implementations

## Usage

Simply call the function like so

```ts
import { localStorageVar } from 'localstorage-var'
import { toAsync } from '@lbfalvy/mini-events'
import { rtrAgent } from 'simple-rtr'
import { time } from "mockable-timer";

const rtr = rtrAgent({
	renewOnTtl: 60, // Renew a minute before expiry
	lockExpiry: 5, // Wait 5 seconds on network error
	storage: toAsync(localStorageVar('auth-data'), undefined),
	time: time,
	refresh: async refresh => { // Example implementation
		const data = await fetch('/api/refresh', {
			method: 'POST',
			body: refresh
		})
		if (data.ok) return await data.json()
		if (data.status == 401) return 'invalid'
		throw new Error(`HTTP error ${response.status}`)
	}
})
```

given the above code, you can manage sessions like so

```ts
rtr.setPair(myTokens) // Log in
rtr.setPair(undefined) // Log out
rtr.session.changed(tokenVar => {
	if (tokenVar) {
		// Logged in
		const token = tokenVar.get() // Obtain a fresh access token
		tokenVar.changed(token => {
			// access token refreshed
		})
	} else {
		// Logged out
	}
})
```

You can force a token refresh if for whatever reason you deem necessary
(for example, if you want to check with the server that the session is
still valid). This will throw if the refresh fails. It will both throw
and schedule a retry if the refresh fails due to an error other than an
invalid token.

```ts
await rtr.forceRefresh()
```

The `TokenPair` structure which is passed to `setPair` and returned by
`refresh` is defined like this:

```ts
interface TokenPair {
    auth: string
    refresh: string
}
```

## Todo

Currently the library does not use a backoff strategy, which means that
in absence of internet connection it will keep retrying at a constant
rate as specified in the `lockExpiry` option. This isn't a huge deal,
especially since it's only done once per website and not once per page,
but it's something to think of.