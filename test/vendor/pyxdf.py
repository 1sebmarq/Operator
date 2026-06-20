# Authors: Christian Kothe & the Intheon pyxdf team
#          Chadwick Boulay
#          Tristan Stenner
#          Clemens Brunner
#
# License: BSD (2-clause)
#
# Vendored from xdf-modules/pyxdf (src/pyxdf/pyxdf.py) because the sandbox has no
# PyPI access. Depends only on numpy. Used by validate_xdf.py as the validation
# gate's reference loader.

"""Defines the function load_xdf, which imports XDF files.

This function is closely following the load_xdf reference implementation.
"""

import gzip
import io
import itertools
import logging
import struct
from collections import OrderedDict, defaultdict
from pathlib import Path
from xml.etree.ElementTree import ParseError, fromstring

import numpy as np

__all__ = ["load_xdf"]

logger = logging.getLogger(__name__)


class StreamData:
    """Temporary per-stream data."""

    def __init__(self, xml):
        """Init a new StreamData object from a stream header."""
        fmts = dict(
            double64=np.float64,
            float32=np.float32,
            string=object,
            int32=np.int32,
            int16=np.int16,
            int8=np.int8,
            int64=np.int64,
        )
        # number of channels
        self.nchns = int(xml["info"]["channel_count"][0])
        # nominal sampling rate in Hz
        self.srate = float(xml["info"]["nominal_srate"][0])
        # format string (int8, int16, int32, float32, double64, string)
        self.fmt = xml["info"]["channel_format"][0]
        # list of time-stamp chunks (each an ndarray, in seconds)
        self.time_stamps = []
        # list of time-series chunks (each an ndarray or list of lists)
        self.time_series = []
        # list of clock offset measurement times (in seconds)
        self.clock_times = []
        # list of clock offset measurement values (in seconds)
        self.clock_values = []
        # last observed time stamp, for delta decompression
        self.last_timestamp = 0.0
        # nominal sampling interval, in seconds, for delta decompression
        self.tdiff = 1.0 / self.srate if self.srate > 0 else 0.0
        self.effective_srate = 0.0
        # list of segments corresponding to detected time-stamp breaks
        # (each a tuple of start_idx, end_idx)
        self.segments = []
        # list of segments corresponding to detected clock resets (each
        # a tuple of start_idx, end_idx)
        self.clock_segments = []
        # pre-calc some parsing parameters for efficiency
        if self.fmt != "string":
            self.dtype = np.dtype(fmts[self.fmt])
            # number of bytes to read from stream to handle one sample
            self.samplebytes = self.nchns * self.dtype.itemsize


def load_xdf(
    filename,
    select_streams=None,
    *,
    on_chunk=None,
    synchronize_clocks=True,
    handle_clock_resets=True,
    dejitter_timestamps=True,
    jitter_break_threshold_seconds=1,
    jitter_break_threshold_samples=500,
    clock_reset_threshold_seconds=5,
    clock_reset_threshold_stds=5,
    clock_reset_threshold_offset_seconds=1,
    clock_reset_threshold_offset_stds=10,
    winsor_threshold=0.0001,
    verbose=None,
):
    """Import an XDF file. See upstream pyxdf docs for full parameter detail."""
    if verbose is not None:
        logger.setLevel(logging.DEBUG if verbose else logging.WARNING)

    logger.info("Importing XDF file %s..." % filename)

    if select_streams is None:
        pass
    elif isinstance(select_streams, int):
        select_streams = [select_streams]
    elif all([isinstance(elem, dict) for elem in select_streams]):
        select_streams = match_streaminfos(resolve_streams(filename), select_streams)
        if not select_streams:  # no streams found
            raise ValueError("No matching streams found.")
    elif not all([isinstance(elem, int) for elem in select_streams]):
        raise ValueError(
            "Argument 'select_streams' must be an int, a list of ints, or a list of "
            "dicts."
        )

    streams = OrderedDict()
    temp = {}
    fileheader = None

    with open_xdf(filename) as f:
        while True:
            try:
                chunklen = _read_varlen_int(f)
            except EOFError:
                break
            except Exception:
                logger.exception("Error reading chunk length")
                if f.read(1):
                    logger.warning(
                        "got zero-length chunk, scanning forward to next boundary "
                        "chunk."
                    )
                    f.seek(-1, 1)
                    if _scan_forward(f):
                        continue
                logger.info("  reached end of file.")
                break

            tag = struct.unpack("<H", f.read(2))[0]
            log_str = " Read tag: {} at {} bytes, length={}"
            log_str = log_str.format(tag, f.tell(), chunklen)
            StreamId = None
            if tag in [2, 3, 4, 6]:
                _streamid = f.read(4)
                try:
                    StreamId = struct.unpack("<I", _streamid)[0]
                except struct.error:
                    log_str += (
                        ", StreamId is corrupt, scanning forward to next boundary "
                        "chunk."
                    )
                    logger.error(log_str)
                    _scan_forward(f)
                    continue
                else:
                    log_str += ", StreamId={}".format(StreamId)
                    logger.debug(log_str)

            if StreamId is not None and select_streams is not None:
                if StreamId not in select_streams:
                    f.read(chunklen - 2 - 4)
                    continue

            if tag == 1:
                xml_string = f.read(chunklen - 2)
                fileheader = _xml2dict(fromstring(xml_string))
            elif tag == 2:
                xml_string = f.read(chunklen - 6)
                decoded_string = xml_string.decode("utf-8", "replace")
                hdr = _xml2dict(fromstring(decoded_string))
                streams[StreamId] = hdr
                logger.debug("  found stream " + hdr["info"]["name"][0])
                temp[StreamId] = StreamData(hdr)
            elif tag == 3:
                try:
                    nsamples, stamps, values = _read_chunk3(f, temp[StreamId])
                    logger.debug(f"  reading [{temp[StreamId].nchns},{nsamples}]")
                    if on_chunk is not None:
                        values, stamps, streams[StreamId] = on_chunk(
                            values, stamps, streams[StreamId], StreamId
                        )
                    temp[StreamId].time_series.append(values)
                    temp[StreamId].time_stamps.append(stamps)
                except Exception as e:
                    logger.error(
                        f"found likely XDF file corruption ({e}), scanning forward to "
                        "next boundary chunk."
                    )
                    _scan_forward(f)
            elif tag == 6:
                xml_string = f.read(chunklen - 6)
                try:
                    streams[StreamId]["footer"] = _xml2dict(fromstring(xml_string))
                except ParseError as e:
                    logger.error(
                        f"found likely XDF file corruption ({e}), ignoring corrupted "
                        "XML element in footer."
                    )
            elif tag == 4:
                temp[StreamId].clock_times.append(struct.unpack("<d", f.read(8))[0])
                temp[StreamId].clock_values.append(struct.unpack("<d", f.read(8))[0])
            else:
                f.read(chunklen - 2)

    for stream in temp.values():
        if stream.time_stamps:
            stream.time_stamps = np.concatenate(stream.time_stamps)
            if stream.fmt == "string":
                stream.time_series = list(itertools.chain(*stream.time_series))
            else:
                stream.time_series = np.concatenate(stream.time_series)
        else:
            stream.time_stamps = np.zeros((0,))
            if stream.fmt == "string":
                stream.time_series = []
            else:
                stream.time_series = np.zeros((0, stream.nchns))

    if synchronize_clocks:
        temp = _truncate_corrupted_offsets(temp, streams)

    if synchronize_clocks:
        logger.info("  performing clock synchronization...")
        temp = _clock_sync(
            temp,
            handle_clock_resets,
            clock_reset_threshold_stds,
            clock_reset_threshold_seconds,
            clock_reset_threshold_offset_stds,
            clock_reset_threshold_offset_seconds,
            winsor_threshold,
        )

    if dejitter_timestamps:
        logger.info("  performing jitter removal...")
        temp = _jitter_removal(
            temp,
            jitter_break_threshold_seconds,
            jitter_break_threshold_samples,
            stream_headers=streams,
        )
    else:
        for stream in temp.values():
            if stream.srate != 0 and len(stream.time_stamps) > 1:
                duration = stream.time_stamps[-1] - stream.time_stamps[0]
                stream.effective_srate = (len(stream.time_stamps) - 1) / duration
            if len(stream.time_stamps) > 0:
                stream.segments.append((0, len(stream.time_stamps) - 1))

    for k in streams.keys():
        stream = streams[k]
        tmp = temp[k]
        if "stream_id" in stream["info"]:
            logger.warning(
                "Found existing 'stream_id' key with value {} in StreamHeader XML. "
                "Using the 'stream_id' value {} from the beginning of the StreamHeader "
                "chunk instead.".format(stream["info"]["stream_id"], k)
            )
        if synchronize_clocks:
            if tmp.segments != tmp.clock_segments:
                logger.warning(f"Stream {k}: Segments and clock-segments differ")
        stream["info"]["stream_id"] = k
        stream["info"]["effective_srate"] = tmp.effective_srate
        stream["info"]["segments"] = tmp.segments
        stream["info"]["clock_segments"] = tmp.clock_segments
        stream["time_series"] = tmp.time_series
        stream["time_stamps"] = tmp.time_stamps
        stream["clock_times"] = tmp.clock_times
        stream["clock_values"] = tmp.clock_values

    streams = [s for s in streams.values()]
    return streams, fileheader


def open_xdf(file):
    """Open XDF file for reading."""
    if isinstance(file, (io.RawIOBase, io.BufferedIOBase)):
        if isinstance(file, io.TextIOBase):
            raise ValueError("file has to be opened in binary mode")
        f = file
    else:
        filename = Path(file)
        if not filename.resolve().exists():
            raise Exception("file %s does not exist." % filename)
        if filename.suffix == ".xdfz" or filename.suffixes == [".xdf", ".gz"]:
            f = gzip.open(str(filename), "rb")
        else:
            f = open(str(filename), "rb")
    if f.read(4) != b"XDF:":
        raise IOError("Invalid XDF file {}".format(file))
    return f


def _read_chunk3(f, s):
    nsamples = _read_varlen_int(f)
    stamps = np.zeros((nsamples,))
    if s.fmt == "string":
        values = [[None] * s.nchns for _ in range(nsamples)]
        for k in range(nsamples):
            if f.read(1) != b"\x00":
                stamps[k] = struct.unpack("<d", f.read(8))[0]
            else:
                stamps[k] = s.last_timestamp + s.tdiff
            s.last_timestamp = stamps[k]
            for ch in range(s.nchns):
                raw = f.read(_read_varlen_int(f))
                values[k][ch] = raw.decode(errors="replace")
    else:
        values = np.zeros((nsamples, s.nchns), dtype=s.dtype)
        raw = bytearray(s.nchns * values.dtype.itemsize)
        for k in range(values.shape[0]):
            if f.read(1) != b"\x00":
                stamps[k] = struct.unpack("<d", f.read(8))[0]
            else:
                stamps[k] = s.last_timestamp + s.tdiff
            s.last_timestamp = stamps[k]
            f.readinto(raw)
            values[k, :] = np.frombuffer(
                raw, dtype=s.dtype.newbyteorder("<"), count=s.nchns
            )
    return nsamples, stamps, values


_read_varlen_int_buf = bytearray(1)


def _read_varlen_int(f):
    """Read a variable-length integer."""
    if not f.readinto(_read_varlen_int_buf):
        raise EOFError()
    nbytes = _read_varlen_int_buf[0]
    if nbytes == 1:
        return ord(f.read(1))
    elif nbytes == 4:
        return struct.unpack("<I", f.read(4))[0]
    elif nbytes == 8:
        return struct.unpack("<Q", f.read(8))[0]
    else:
        raise RuntimeError("invalid variable-length integer encountered.")


def _xml2dict(t):
    """Convert an attribute-less etree.Element into a dict."""
    dd = defaultdict(list)
    for dc in map(_xml2dict, list(t)):
        for k, v in dc.items():
            dd[k].append(v)
    return {t.tag: dd or t.text}


def _scan_forward(f):
    """Scan forward through file object until after the next boundary chunk."""
    blocklen = 2**20
    signature = bytes(
        [
            0x43, 0xA5, 0x46, 0xDC, 0xCB, 0xF5, 0x41, 0x0F,
            0xB3, 0x0E, 0xD5, 0x46, 0x73, 0x83, 0xCB, 0xE4,
        ]
    )
    while True:
        curpos = f.tell()
        block = f.read(blocklen)
        matchpos = block.find(signature)
        if matchpos != -1:
            f.seek(curpos + matchpos + len(signature))
            logger.debug("  scan forward found a boundary chunk.")
            return True
        if len(block) < blocklen:
            logger.debug("  scan forward reached end of file with no match.")
            return False


def _find_segment_indices(b_breaks):
    break_inds = np.where(b_breaks)[0]
    start_idx = np.hstack(([0], break_inds + 1))
    end_idx = np.hstack((break_inds, len(b_breaks)))
    segments = list(zip(start_idx.tolist(), end_idx.tolist()))
    return segments, start_idx, end_idx


def _segment_clock_diff(diff, thresh_stds, thresh_secs):
    median = np.median(diff)
    diffs_shift = diff - median
    diffs_shift_abs = np.abs(diffs_shift)
    mad = np.median(diffs_shift_abs) + np.finfo(float).eps
    diffs_std = diffs_shift / mad
    cond1 = np.abs(diffs_std) > thresh_stds
    cond2 = diffs_shift_abs > thresh_secs
    b_break = cond1 & cond2
    return b_break


def _detect_corrupted_clock_offset(
    clock_times,
    clock_values,
    time_thresh=10.0,
    value_thresh=10.0,
):
    times = np.asarray(clock_times)
    values = np.asarray(clock_values)
    if len(times) < 3:
        return False
    intervals = np.diff(times)
    median_interval = np.median(intervals[:-1])
    last_interval = np.abs(intervals[-1])
    if median_interval > 0:
        time_ratio = last_interval / median_interval
    else:
        time_ratio = np.inf if last_interval > 0 else 1.0
    median_val = np.median(values[:-1])
    mad = np.median(np.abs(values[:-1] - median_val))
    if mad > np.finfo(float).eps:
        value_zscore = np.abs(values[-1] - median_val) / (1.4826 * mad)
    else:
        value_zscore = 0.0
    return time_ratio > time_thresh or value_zscore > value_thresh


def _truncate_corrupted_offsets(temp, streams):
    for stream_id, stream in temp.items():
        footer = streams.get(stream_id, {}).get("footer", {}).get("info") or {}
        sample_count_str = footer.get("sample_count", [None])[0]
        if sample_count_str is None:
            continue
        footer_count = int(sample_count_str)
        if len(stream.time_stamps) <= footer_count:
            continue
        clock_corrupted = False
        if len(stream.clock_times) >= 3:
            clock_corrupted = _detect_corrupted_clock_offset(
                stream.clock_times, stream.clock_values
            )
        if not clock_corrupted:
            continue
        logger.warning(
            "Stream %s: last clock offset is statistically anomalous, "
            "truncating (see pylsl#67, liblsl#246).",
            stream_id,
        )
        stream.clock_times = stream.clock_times[:-1]
        stream.clock_values = stream.clock_values[:-1]
        logger.warning(
            "Stream %s: sample count (%d) exceeds footer sample_count (%d), "
            "truncating extra samples.",
            stream_id,
            len(stream.time_stamps),
            footer_count,
        )
        stream.time_stamps = stream.time_stamps[:footer_count]
        stream.time_series = stream.time_series[:footer_count]
    return temp


def _detect_clock_resets(
    stream,
    time_thresh_stds,
    time_thresh_secs,
    value_thresh_stds,
    value_thresh_secs,
):
    if len(stream.clock_times) <= 1:
        raise ValueError("Two or more clock offsets are required for reset detection")
    time_diff = np.diff(stream.clock_times)
    value_diff = np.diff(stream.clock_values)
    decreasing = time_diff < 0
    time_glitch = _segment_clock_diff(time_diff, time_thresh_stds, time_thresh_secs)
    value_glitch = _segment_clock_diff(value_diff, value_thresh_stds, value_thresh_secs)
    resets_at = decreasing | time_glitch & value_glitch
    segments = _find_segment_indices(resets_at)[0]
    return segments


def _clock_sync(
    streams,
    handle_clock_resets=True,
    reset_threshold_stds=5,
    reset_threshold_seconds=5,
    reset_threshold_offset_stds=10,
    reset_threshold_offset_seconds=1,
    winsor_threshold=0.0001,
):
    for stream_id, stream in streams.items():
        if len(stream.time_stamps) > 0:
            clock_times = stream.clock_times
            clock_values = stream.clock_values
            if not clock_times:
                continue
            if handle_clock_resets and len(clock_times) > 1:
                logger.debug(f" Handling clock resets stream: {stream_id}")
                ranges = _detect_clock_resets(
                    stream,
                    reset_threshold_stds,
                    reset_threshold_seconds,
                    reset_threshold_offset_stds,
                    reset_threshold_offset_seconds,
                )
            else:
                ranges = [(0, len(clock_times) - 1)]
            logger.debug(f"  Clock reset ranges: {ranges}")
            coef = []
            for range_i in ranges:
                if range_i[0] != range_i[1]:
                    start, stop = range_i[0], range_i[1] + 1
                    X = np.column_stack(
                        [
                            np.ones(stop - start),
                            np.array(clock_times[start:stop]) / winsor_threshold,
                        ]
                    )
                    y = np.array(clock_values[start:stop]) / winsor_threshold
                    try:
                        _coefs = _robust_fit(X, y)
                        _coefs[0] *= winsor_threshold
                    except np.linalg.LinAlgError:
                        logger.warning(
                            f"Stream {stream_id}: "
                            f"Clock offsets {range_i} cannot be used for synchronization"
                        )
                        _coefs = [0, 0]
                    coef.append(_coefs)
                else:
                    coef.append((clock_values[range_i[0]], 0))
            if len(ranges) == 1:
                stream.time_stamps += coef[0][0] + (coef[0][1] * stream.time_stamps)
                stream.clock_segments.append((0, len(stream.time_stamps) - 1))
            else:
                ts_start = 0
                for coef_i, range_i in zip(coef, ranges):
                    stop = range_i[1] + 1
                    if stop < len(clock_times):
                        current_end_t = clock_times[range_i[1]]
                        next_start_t = clock_times[stop]
                        cond = np.less(
                            np.abs(stream.time_stamps[ts_start:] - current_end_t),
                            np.abs(stream.time_stamps[ts_start:] - next_start_t),
                        )
                        if all(cond):
                            ts_stop = ts_start + len(cond)
                        else:
                            ts_stop = ts_start + np.argmin(cond).item()
                    else:
                        ts_stop = len(stream.time_stamps)
                    if ts_start == ts_stop:
                        logger.warning(
                            (
                                f"Stream {stream_id}: "
                                f"No samples in clock offsets {range_i}, skipping..."
                            )
                        )
                    else:
                        stream.clock_segments.append((ts_start, ts_stop - 1))
                        ts_slice = slice(ts_start, ts_stop)
                        ts_start = ts_stop
                        stream.time_stamps[ts_slice] += (
                            coef_i[0] + coef_i[1] * stream.time_stamps[ts_slice]
                        )
    return streams


def _detect_breaks(stream, threshold_seconds=1.0, threshold_samples=500):
    diffs = np.diff(stream.time_stamps)
    b_breaks = np.abs(diffs) > np.max(
        (threshold_seconds, threshold_samples * stream.tdiff)
    )
    return b_breaks


def _stream_can_drop_samples(stream_meta):
    if not stream_meta:
        return False
    info = stream_meta.get("info", {})
    desc = info.get("desc")
    if not isinstance(desc, list) or len(desc) == 0 or not isinstance(desc[0], dict):
        return False
    synchronization = desc[0].get("synchronization")
    if (
        not isinstance(synchronization, list)
        or len(synchronization) == 0
        or not isinstance(synchronization[0], dict)
    ):
        return False
    can_drop_samples = synchronization[0].get("can_drop_samples")
    if not isinstance(can_drop_samples, list) or len(can_drop_samples) == 0:
        return False
    return str(can_drop_samples[0]).lower() == "true"


def _jitter_removal(
    streams,
    threshold_seconds=1,
    threshold_samples=500,
    stream_headers=None,
):
    for stream_id, stream in streams.items():
        stream.effective_srate = 0
        nsamples = len(stream.time_stamps)
        if nsamples > 0:
            if stream.srate == 0:
                stream.segments.append((0, nsamples - 1))
                continue
            if _stream_can_drop_samples(
                None if stream_headers is None else stream_headers.get(stream_id)
            ):
                stream.segments.append((0, nsamples - 1))
                if nsamples > 1:
                    duration = stream.time_stamps[-1] - stream.time_stamps[0]
                    if duration > 0:
                        stream.effective_srate = (nsamples - 1) / duration
                continue
            b_breaks = _detect_breaks(stream, threshold_seconds, threshold_samples)
            segments, start_idx, stop_idx = _find_segment_indices(b_breaks)
            logger.debug(f" Stream {stream_id}: segments={len(segments)}")
            stream.segments.extend(segments)
            for start_i, stop_i in segments:
                idx = np.arange(start_i, stop_i + 1, 1)[:, None]
                X = np.concatenate((np.ones_like(idx), idx), axis=1)
                y = stream.time_stamps[idx]
                mapping = np.linalg.lstsq(X, y, rcond=-1)[0]
                stream.time_stamps[idx] = mapping[0] + mapping[1] * idx
            counts = (stop_idx + 1) - start_idx
            if np.any(counts > 1):
                durations = stream.time_stamps[stop_idx] - stream.time_stamps[start_idx]
                stream.effective_srate = np.sum(counts - 1) / np.sum(durations)
            srate, effective_srate = stream.srate, stream.effective_srate
            if np.abs(srate - effective_srate) / srate > 0.1:
                msg = (
                    "Stream %d: Calculated effective sampling rate %.4f Hz is different "
                    "from specified rate %.4f Hz."
                )
                logger.warning(msg, stream_id, effective_srate, srate)
    return streams


def _robust_fit(A, y, rho=1, iters=1000):
    A = np.copy(A)
    offset = np.min(A[:, 1])
    A[:, 1] -= offset
    Aty = np.dot(A.T, y)
    L = np.linalg.cholesky(np.dot(A.T, A))
    U = L.T
    z = np.zeros_like(y)
    u = z
    x = z
    for k in range(iters):
        x = np.linalg.solve(U, (np.linalg.solve(L, Aty + np.dot(A.T, z - u))))
        d = np.dot(A, x) - y + u
        d_inv = np.zeros_like(d)
        np.divide(1, d, out=d_inv, where=d != 0)
        tmp = np.maximum(0, (1 - (1 + 1 / rho) * np.abs(d_inv)))
        z = rho / (1 + rho) * d + 1 / (1 + rho) * tmp * d
        u = d - z
    x[0] -= x[1] * offset
    return x


def match_streaminfos(stream_infos, parameters, *, case_sensitive=True):
    matches = []
    match = False
    for request in parameters:
        for info in stream_infos:
            for key in request.keys():
                if case_sensitive:
                    match = info[key] == request[key]
                else:
                    match = info[key].lower() == request[key].lower()
                if not match:
                    break
            if match:
                matches.append(info["stream_id"])
    return list(set(matches))


def resolve_streams(fname):
    return parse_chunks(parse_xdf(fname))


def parse_xdf(fname):
    chunks = []
    with open_xdf(fname) as f:
        for chunk in _read_chunks(f):
            chunks.append(chunk)
    return chunks


def parse_chunks(chunks):
    streams = []
    for chunk in chunks:
        if chunk["tag"] == 2:
            streams.append(
                dict(
                    stream_id=chunk["stream_id"],
                    name=chunk.get("name"),
                    type=chunk.get("type"),
                    source_id=chunk.get("source_id"),
                    created_at=chunk.get("created_at"),
                    uid=chunk.get("uid"),
                    session_id=chunk.get("session_id"),
                    hostname=chunk.get("hostname"),
                    channel_count=int(chunk["channel_count"]),
                    channel_format=chunk["channel_format"],
                    nominal_srate=float(chunk["nominal_srate"]),
                )
            )
    return streams


def _read_chunks(f):
    while True:
        chunk = dict()
        try:
            chunk["nbytes"] = _read_varlen_int(f)
        except EOFError:
            return
        chunk["tag"] = struct.unpack("<H", f.read(2))[0]
        if chunk["tag"] in [2, 3, 4, 6]:
            chunk["stream_id"] = struct.unpack("<I", f.read(4))[0]
            if chunk["tag"] == 2:
                msg = f.read(chunk["nbytes"] - 6).decode("utf-8", "replace")
                xml = fromstring(msg)
                chunk = {**chunk, **_parse_streamheader(xml)}
            else:
                f.seek(chunk["nbytes"] - 6, 1)
        else:
            f.seek(chunk["nbytes"] - 2, 1)
        yield chunk


def _parse_streamheader(xml):
    return {el.tag: el.text for el in xml if el.tag != "desc"}
