// ==UserScript==
// @name         Advanced Video Controls
// @namespace    https://www.fabioiotti.com/
// @version      0.5.0
// @description  Play/pause, change speed, step, full-screen. Everywhere, not just on YouTube.
// @author       Fabio Iotti
// @match        http*://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        none
// ==/UserScript==

(() => {
	'use strict';

	const CONTROLS_REGISTERED_SYMBOL = Symbol("ControlsRegistered");
	const EXPECTED_FRAME_DURATION = Symbol("ExpectedFrameDuration");
	const NEXT_FRAME_REQUEST_IN_PROGRESS = Symbol("NextFrameRequestInProgress");
	const CURRENT_TIME_PENDING = Symbol("CurrentTimePending");
	const IS_THEATER_MODE = Symbol("IsTheaterMode");
	const IS_FULLSCREEN_MODE = Symbol("IsFullscreenMode");

	let lastCommandDate = 0;
	let cumulativeSeek = 0;
	let cumulativeFrames = 0;

	/** @type {(() => void)|undefined} */
	let restoreOriginalState;

	window.addEventListener('contextmenu', e => {
		if (e.target.matches('audio, video'))
			e.stopImmediatePropagation();
	});

	window.addEventListener('keydown', e => {
		const el = /** @type {HTMLElement} */(e.target);
		if (el.matches('input, textarea, [contenteditable]'))
			return;

		const video = findNetflixTargetVideo() ?? findTargetVideo();

		if (video == null)
			return;

		// play/pause
		if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "k" || e.key === " ")) {
			e.stopImmediatePropagation();
			e.preventDefault();

			const playing = video.currentTime > 0 && !video.paused && !video.ended;
			pulseMessage(video, playing ? "Paused" : "Playing");
			playing ? video.pause() : video.play();
		}

		// rewind
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "j") {
			e.stopImmediatePropagation();
			e.preventDefault();

			if (Date.now() - lastCommandDate > 1500)
				cumulativeSeek = 0;

			const previousTime = video.currentTime;
			video.currentTime = Math.max(0, previousTime - 10);

			cumulativeSeek += (video.currentTime - previousTime);
			lastCommandDate = Date.now();

			pulseMessage(video, `${cumulativeSeek > 0 ? "+" : ""}${cumulativeSeek.toFixed(0)} sec`);
		}

		// fast-forward
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "l") {
			e.stopImmediatePropagation();
			e.preventDefault();

			if (Date.now() - lastCommandDate > 1500)
				cumulativeSeek = 0;

			const previousTime = video.currentTime;
			video.currentTime = Math.max(0, previousTime + 10);

			cumulativeSeek += (video.currentTime - previousTime);
			lastCommandDate = Date.now();

			pulseMessage(video, `${cumulativeSeek > 0 ? "+" : ""}${cumulativeSeek.toFixed(0)} sec`);
		}

		// speed up
		else if (!e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === '>') {
			e.stopImmediatePropagation();
			e.preventDefault();

			video.playbackRate = Math.min(4, video.playbackRate + .25);
			pulseMessage(video, `Speed: ${video.playbackRate}`);
		}

		// slow down
		else if (!e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === '<') {
			e.stopImmediatePropagation();
			e.preventDefault();

			video.playbackRate = Math.max(.25, video.playbackRate - .25);
			pulseMessage(video, `Speed: ${video.playbackRate}`);
		}

		// previous frame
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ',') {
			e.stopImmediatePropagation();
			e.preventDefault();

			const playing = video.currentTime > 0 && !video.paused && !video.ended;
			if (playing)
				return;

			if (Date.now() - lastCommandDate > 1500)
				cumulativeFrames = 0;

			lastCommandDate = Date.now();

			pulseMessage(video, cumulativeFrames == 0 ? "Seeking..." : `${cumulativeFrames > 0 ? "+" : ""}${cumulativeFrames} frames`);

			nextFrame(video, -1).then(ok => {
				if (!ok)
					return;

				cumulativeFrames--;
				pulseMessage(video, `${cumulativeFrames > 0 ? "+" : ""}${cumulativeFrames} frames`);
			});
		}

		// next frame
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === '.') {
			e.stopImmediatePropagation();
			e.preventDefault();

			const playing = video.currentTime > 0 && !video.paused && !video.ended;
			if (playing)
				return;

			if (Date.now() - lastCommandDate > 1500)
				cumulativeFrames = 0;

			lastCommandDate = Date.now();

			pulseMessage(video, cumulativeFrames == 0 ? "Seeking..." : `${cumulativeFrames > 0 ? "+" : ""}${cumulativeFrames} frames`);

			nextFrame(video, +1).then(ok => {
				if (!ok)
					return;

				cumulativeFrames++;
				pulseMessage(video, `${cumulativeFrames > 0 ? "+" : ""}${cumulativeFrames} frames`);
			});
		}

		// fullscreen (native controls only)
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'F11') {
			e.stopImmediatePropagation();
			e.preventDefault();

			if (document.fullscreenElement == null) {
				enableVideoControls();
				video.requestFullscreen();
			}
		}

		// fullscreen (including page)
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'f') {
			e.stopImmediatePropagation();
			e.preventDefault();

			enableVideoControls(video);

			if (video[IS_FULLSCREEN_MODE]) {
				restoreOriginalState();
				restoreOriginalState = undefined
			}
			else {
				const restore = elevateElement(video);
				document.documentElement.requestFullscreen();
				video[IS_FULLSCREEN_MODE] = true;

				restoreOriginalState?.();
				restoreOriginalState = () => {
					video[IS_FULLSCREEN_MODE] = false;
					if (document.fullscreenElement != null)
						document.exitFullscreen();
					restore();
				};
			}

			/** @param {Event} e */
			const exitFullscreenListener = (e) => {
				if (document.fullscreenElement != null)
					return;

				if (video[IS_FULLSCREEN_MODE]) {
					restoreOriginalState();
					restoreOriginalState = undefined
				}

				document.removeEventListener('fullscreenchange', exitFullscreenListener);
			};

			document.addEventListener('fullscreenchange', exitFullscreenListener);
		}

		// theater mode
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 't') {
			e.stopImmediatePropagation();
			e.preventDefault();

			enableVideoControls(video);

			if (video[IS_THEATER_MODE]) {
				restoreOriginalState();
				restoreOriginalState = undefined
			}
			else {
				const restore = elevateElement(video);
				video[IS_THEATER_MODE] = true;

				restoreOriginalState?.();
				restoreOriginalState = () => {
					video[IS_THEATER_MODE] = false;
					restore();
				};
			}
		}

		// restore original state (from theater mode)
		else if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'Escape') {
			if (restoreOriginalState != null) {
				e.stopImmediatePropagation();
				e.preventDefault();

				restoreOriginalState();
				restoreOriginalState = undefined;
			}
		}
	}, true);

	/**
	 * Find the video element the user is currently interested in.
	 */
	const findTargetVideo = () => {
		// find all videos with a duration (ignore video elements without a video)
		const videos = [...document.querySelectorAll('video')].filter(v => v.duration);

		if (!videos)
			return;

		// find the position of the active element
		const rect = document.activeElement?.getBoundingClientRect() ?? { top: 0, left: 0, width: 0, height: 0 };
		const pos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

		// find the video element closest to the active element
		const video = videos
			.map(video => ({ video, dist: dist(pos, video) }))
			.sort((a, b) => (a.dist !== 0 || b.dist !== 0) ? (a.dist - b.dist) : -compareZIndex(a.video, b.video))
		[0]?.video;

		return video;
	};

	/**
	 * Find the video element the user is currently interested in, on Netflix.
	 */
	const findNetflixTargetVideo = () => {
		try {
			if (typeof netflix === 'undefined' || location.host !== 'www.netflix.com')
				return null;

			const video = findTargetVideo();

			const api = netflix.appContext.state.playerApp.getAPI();
			const player = api.videoPlayer.getVideoPlayerBySessionId(api.videoPlayer.getAllPlayerSessionIds([0]));

			// adapt video to support Netflix's DRM shenanigans
			return new Proxy(video, {
				get(video, prop, receiver) {
					if (typeof video[prop] === 'function')
						return (...args) => video[prop](...args);

					if (prop === 'currentTime') {
						if (video[CURRENT_TIME_PENDING]?.start === video.currentTime)
							return video[CURRENT_TIME_PENDING].target;

						return video.currentTime;
					}

					return video[prop];
				},
				set(video, prop, value) {
					if (prop === 'currentTime') {
						const seekTarget = value;  // TODO: Netflix only seeks to keyframes.
						video[CURRENT_TIME_PENDING] = { start: video.currentTime, target: seekTarget };
						player.seek(seekTarget * 1000);
						return video.currentTime;
					}

					return video[prop] = value;
				},
			});
		}
		catch (e) { }

		return null;
	};

	/**
	 * Distance between a point and an element's position.
	 * @param {{ x: number, y: number }} pos
	 * @param {HTMLElement} el
	 */
	const dist = (pos, el) => {
		const rect = el.getBoundingClientRect();
		const distX = pos.x < rect.left ? (rect.left - pos.x) : pos.x > rect.right ? (pos.x - rect.right) : 0;
		const distY = pos.y < rect.top ? (rect.top - pos.y) : pos.y > rect.bottom ? (pos.y - rect.bottom) : 0;
		const dist = Math.sqrt(distX * distX + distY * distY);
		return dist;
	};

	/**
	 * Compare z-index of two elements.
	 * @param {HTMLElement} a
	 * @param {HTMLElement} b
	 * @returns {number}
	 */
	const compareZIndex = (a, b) => {
		// same element? same z-index
		if (a === b)
			return 0;

		// on different trees? cannot compare z-index
		const parent = firstCommonAncestor(a, b);
		if (parent == null)
			return 0;

		// `a` is parent of `b`? then `a` comes first (unless its z-index is negative)
		if (parent === a) {
			const zIndexA = getComputedStyle(a).zIndex;
			return +zIndexA || 0; // `or 0` in case of NaN
		}

		// `b` is parent of `a`? then `b` comes first (unless its z-index is negative)
		if (parent === b) {
			const zIndexB = getComputedStyle(b).zIndex;
			return -zIndexB || 0; // `or 0` in case of NaN
		}

		// find direct child of `parent` which is `a` or ancestor of `a`
		let baseA = a;
		while (baseA.parentElement !== parent)
			baseA = baseA.parentElement;

		// find direct child of `parent` which is `b` or ancestor of `b`
		let baseB = b;
		while (baseB.parentElement !== parent)
			baseB = baseB.parentElement;

		// try to compare z-index (same parent, so same stacking context guaranteed)
		const zIndexA = +getComputedStyle(baseA).zIndex || 0; // `or 0` in case of NaN
		const zIndexB = +getComputedStyle(baseB).zIndex || 0; // `or 0` in case of NaN
		if (zIndexA !== zIndexB)
			return zIndexA - zIndexB;

		// find the child of `parent` which appears first
		// TODO: this is not bullet-proof, children might have been reordered.
		for (const child of parent.children) {
			if (child === baseA)
				return -1;
			if (child === baseB)
				return 1;
		}

		// something went wrong
		return 0;
	};

	/**
	 * Find the first common ancestor of two elements.
	 * @param {HTMLElement} a
	 * @param {HTMLElement} b
	 * @returns {HTMLElement|null}
	 */
	const firstCommonAncestor = (a, b) => {
		/** @type {Set<HTMLElement>} */
		const parentsA = new Set();

		let candidate = a;
		while (candidate != null) {
			parentsA.add(candidate);
			candidate = candidate.parentElement;
		}

		candidate = b;
		while (candidate != null) {
			if (parentsA.has(candidate))
				return candidate;

			candidate = candidate.parentElement;
		}

		return null;
	};

	/**
	 * @param {number} v
	 * @param {number} min
	 * @param {number} max
	 */
	const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

	let cancelPreviousMessage = () => { };

	/**
	 * Briefly show a message inside a target element.
	 * @param {HTMLElement} target
	 * @param {string} text
	 */
	const pulseMessage = (target, text) => {
		const rect = target.getBoundingClientRect();

		const container = document.createElement('div');
		container.style.position = 'absolute';
		container.style.top = `max(0vh, ${rect.top}px)`;
		container.style.left = `max(0vw, ${rect.left}px)`;
		container.style.width = `min(100vw, ${rect.width}px)`;
		container.style.height = `min(100vh, ${rect.height}px)`;
		container.style.pointerEvents = 'none';
		container.style.display = 'flex';
		container.style.justifyContent = 'center';
		container.style.alignItems = 'center';
		container.style.zIndex = '9999999';

		const content = document.createElement('div');
		content.style.background = '#000000aa';
		content.style.color = 'white';
		content.style.fontFamily = 'sans-serif';
		content.style.fontSize = '24px';
		content.style.padding = '.6em 1em';
		content.style.borderRadius = '99em';
		content.style.opacity = '1';
		content.textContent = text;
		container.appendChild(content);

		document.body.appendChild(container);

		let opacity = 3;
		const fade = () => {
			opacity -= 0.05;  // TODO: make framerate-independent
			if (opacity <= 0) {
				container.parentElement?.removeChild(container);
				return;
			}

			content.style.opacity = `${Math.min(1, opacity)}`;
			requestAnimationFrame(fade);
		};
		fade();

		const cancelMessage = () => {
			opacity = 0;
			fade();
		};

		cancelPreviousMessage();
		cancelPreviousMessage = cancelMessage;
	};

	/**
	 * Elevate target element above everything else and fill the screen.
	 * @param {HTMLElement} el
	 * @return {() => void} Dispose function to be invoked to return to original state.
	 */
	const elevateElement = (el) => {
		/** @typedef {{ el: HTMLElement, style: { [prop: string]: [v: string | null, p: string | undefined] } }} State */

		/**
		 * Override style property and store previous state.
		 * @param {State} state
		 * @param {string} prop
		 * @param {string | null} value
		 * @param {string | undefined} priority
		 */
		const overrideStyle = (state, prop, value, priority) => {
			const oldValue = state.el.style.getPropertyValue(prop);
			const oldPriority = state.el.style.getPropertyPriority(prop);
			state.style[prop] ??= [oldValue, oldPriority];
			state.el.style.setProperty(prop, value, priority);
		};

		/**
		 * Restore style previous state.
		 * @param {State} state
		 */
		const restoreStyle = (state) => {
			for (const prop in state.style) {
				const [oldValue, oldPriority] = state.style[prop];
				state.el.style.setProperty(prop, oldValue, oldPriority);
			}
		};

		/** @type {State[]} */
		const states = [];

		let x = el;
		while (x != null) {
			/** @type {State} */
			const state = { el: x, style: {} };
			overrideStyle(state, 'position', 'fixed', 'important');
			overrideStyle(state, 'z-index', '9999998', 'important');

			if (x === el) {
				overrideStyle(state, 'top', '0', 'important');
				overrideStyle(state, 'left', '0', 'important');
				overrideStyle(state, 'width', '100vw', 'important');
				overrideStyle(state, 'height', '100vh', 'important');
				overrideStyle(state, 'background', 'black', 'important');
			}

			states.push(state);
			x = x.parentElement;
		}

		return () => {
			for (const state of states) {
				restoreStyle(state);
			}
		};
	};

	/**
	 * Permanently enable native video playback controls.
	 * @param {HTMLVideoElement} video
	 */
	const enableVideoControls = (video) => {
		if (!video[CONTROLS_REGISTERED_SYMBOL]) {
			video[CONTROLS_REGISTERED_SYMBOL] = true;

			video.addEventListener('mousemove', e => {
				// prevent YouTube from disabling video controls
				video.removeAttribute("controlslist");
				video.controls = true;
				video.style.setProperty('cursor', 'initial', 'important');
				video.style.setProperty('pointer-events', 'all', 'important');
				e.stopImmediatePropagation();
				requestAnimationFrame(() => {
					video.removeAttribute("controlslist");
					video.controls = true;
					video.style.setProperty('cursor', 'initial', 'important');
					video.style.setProperty('pointer-events', 'all', 'important');
					requestAnimationFrame(() => {
						video.removeAttribute("controlslist");
						video.controls = true;
						video.style.setProperty('cursor', 'initial', 'important');
						video.style.setProperty('pointer-events', 'all', 'important');
					});
				});
			});
		}

		video.removeAttribute("controlslist");
		video.controls = true;
		video.style.setProperty('cursor', 'initial', 'important');
		video.style.setProperty('pointer-events', 'all', 'important');
	};

	/** @type {HTMLCanvasElement | null} */
	let canvas;

	/** @type {CanvasRenderingContext2D | null} */
	let c2d;

	/**
	 * Advance video to next frame.
	 * @param {HTMLVideoElement} video
	 * @param {+1 | -1} direction
	 * @returns {Promise<boolean>}
	 */
	const nextFrame = async (video, direction) => {
		if (video[NEXT_FRAME_REQUEST_IN_PROGRESS])
			return false;

		video[NEXT_FRAME_REQUEST_IN_PROGRESS] = true;
		try {
			const expectedFrameDuration = video[EXPECTED_FRAME_DURATION] ?? 0.004;

			canvas ??= document.createElement('canvas');
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;

			c2d ??= canvas.getContext('2d');
			c2d.drawImage(video, 0, 0);

			const pixelsStart = [...c2d.getImageData(0, 0, canvas.width, canvas.height).data];

			let success = false;

			let timeBeforeSeek = video.currentTime;
			for (var i = 0; i < 50; i++) {
				video.currentTime += clamp(expectedFrameDuration * .5, 0.004, 0.050) * direction;
				await waitSeeked(video);

				c2d.drawImage(video, 0, 0);

				const currentPixels = c2d.getImageData(0, 0, canvas.width, canvas.height).data;
				if (!arrayEqual(currentPixels, pixelsStart)) {
					success = true;
					break;
				}
			}

			const frameDuration = video.currentTime - timeBeforeSeek;
			video[EXPECTED_FRAME_DURATION] = Math.abs(frameDuration);

			//console.debug('steps:', i, 'duration:', frameDuration);
			return success;
		}
		finally {
			video[NEXT_FRAME_REQUEST_IN_PROGRESS] = false;
		}
	};

	/**
	 * @param {HTMLMediaElement} video
	 * @param {number} time
	 */
	const waitSeeked = (video) => {
		return new Promise(resolve => {
			const handler = () => {
				video.removeEventListener('seeked', handler);
				resolve();
			};
			video.addEventListener('seeked', handler);
		});
	};

	/**
	 * @param {Uint8ClampedArray | number[]} a
	 * @param {Uint8ClampedArray | number[]} b
	 */
	const arrayEqual = (a, b) => {
		if (a.length !== b.length)
			return false;

		for (let i = 0; i < a.length; i++)
			if (a[i] !== b[i])
				return false;

		return true;
	};
})();
