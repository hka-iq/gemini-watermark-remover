/**
 * Video Processor module
 * Processes video files frame-by-frame to remove watermarks using the WatermarkEngine.
 */

/**
 * Process a video file and remove watermarks from every frame.
 * Uses HTMLVideoElement + Canvas for decoding, and MediaRecorder for re-encoding.
 *
 * @param {File} videoFile - The input video file
 * @param {WatermarkEngine} engine - The initialized WatermarkEngine instance
 * @param {function(number)} onProgress - Callback called with progress (0–100)
 * @returns {Promise<Blob>} - A Blob of the processed video (video/webm)
 */
export async function removeWatermarkFromVideo(videoFile, engine, onProgress) {
    if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not supported in this browser');
    }

    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';

        const url = URL.createObjectURL(videoFile);
        video.src = url;

        video.addEventListener('error', () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load video'));
        });

        video.addEventListener('loadedmetadata', async () => {
            try {
                const { videoWidth: width, videoHeight: height, duration } = video;

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');

                // Capture audio from the original video stream if available
                const canvasStream = canvas.captureStream(0);
                if (typeof video.captureStream === 'function') {
                    const videoStream = video.captureStream();
                    videoStream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
                }

                const mimeType = getSupportedMimeType();
                const recorder = new MediaRecorder(canvasStream, {
                    mimeType,
                    videoBitsPerSecond: 8_000_000,
                });

                const chunks = [];
                recorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) chunks.push(e.data);
                };
                recorder.onstop = () => {
                    URL.revokeObjectURL(url);
                    resolve(new Blob(chunks, { type: recorder.mimeType }));
                };
                recorder.onerror = (e) => {
                    URL.revokeObjectURL(url);
                    reject(e.error || new Error('MediaRecorder error'));
                };

                recorder.start();

                const fps = (await detectFPS(video)) || 30;
                const frameInterval = 1 / fps;
                const videoTrack = canvasStream.getVideoTracks()[0];

                for (let currentTime = 0; currentTime <= duration; currentTime += frameInterval) {
                    const seekTime = Math.min(currentTime, duration);
                    await seekTo(video, seekTime);

                    const processedCanvas = await engine.removeWatermarkFromImage(video);
                    ctx.drawImage(processedCanvas, 0, 0);

                    if (videoTrack && videoTrack.requestFrame) {
                        videoTrack.requestFrame();
                    }

                    const progress = Math.min(100, Math.round((currentTime / duration) * 100));
                    if (onProgress) onProgress(progress);
                }

                if (onProgress) onProgress(100);
                recorder.stop();
            } catch (err) {
                URL.revokeObjectURL(url);
                reject(err);
            }
        });
    });
}

/**
 * Seek a video element to a specific time and wait for the seeked event.
 * @param {HTMLVideoElement} video
 * @param {number} time - Target time in seconds
 * @returns {Promise<void>}
 */
function seekTo(video, time) {
    return new Promise((resolve) => {
        video.addEventListener('seeked', resolve, { once: true });
        video.currentTime = time;
    });
}

/**
 * Detect video FPS by using requestVideoFrameCallback if available.
 * Falls back to 30 fps.
 * @param {HTMLVideoElement} video
 * @returns {Promise<number>}
 */
async function detectFPS(video) {
    try {
        if ('requestVideoFrameCallback' in video) {
            return await new Promise((resolve) => {
                let frames = 0;
                let startTime = null;
                const timeout = setTimeout(() => resolve(30), 2000);
                const cb = (now, _meta) => {
                    if (!startTime) startTime = now;
                    frames++;
                    if (frames < 10) {
                        video.requestVideoFrameCallback(cb);
                    } else {
                        clearTimeout(timeout);
                        resolve(frames / ((now - startTime) / 1000));
                    }
                };
                video.requestVideoFrameCallback(cb);
                video.play().catch(() => {
                    clearTimeout(timeout);
                    resolve(30);
                });
            });
        }
    } catch {
        // ignore
    }
    return 30;
}

/**
 * Get the best supported MIME type for MediaRecorder output.
 * @returns {string}
 */
function getSupportedMimeType() {
    const types = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4',
    ];
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
}
