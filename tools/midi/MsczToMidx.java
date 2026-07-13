import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Standalone MuseScore .mscz/.mscx to current-format MIDX converter.
 *
 * Current MIDX is a Standard MIDI File superset: native MIDI note-on/off events
 * remain intact, and microtonal pitch offsets are stored as sequencer-specific
 * meta events immediately before the related note-on:
 *
 *   FF 7F 07 7D 58 54 03 <pitch> <offset16_be>
 *
 * The 16-bit offset is signed-magnitude. The low 15 bits cover 0..64 cents.
 *
 * Usage:
 *   javac tools/midi/MsczToMidx.java
 *   java -cp tools/midi MsczToMidx input.mscz [output.midx]
 */
public final class MsczToMidx {
    private static final int DEFAULT_DIVISION = 480;
    private static final int DEFAULT_BPM = 120;
    private static final int DEFAULT_VELOCITY = 80;
    private static final int DEFAULT_TIME_SIG_N = 4;
    private static final int DEFAULT_TIME_SIG_D = 4;

    private static final int MIDX_META_TYPE = 0x7F;
    private static final int MIDX_PAYLOAD_LEN = 7;
    private static final int MIDX_EXPERIMENTAL_MANUFACTURER_ID = 0x7D;
    private static final int MIDX_PITCHED_OFFSET_RECORD_TYPE = 0x03;
    private static final int MIDX_CENT_RANGE = 64;
    private static final int MIDX_SAFE_CENT_RANGE = 63;
    private static final int MIDX_OFFSET_STEPS = 32768;

    private MsczToMidx() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2 || "-h".equals(args[0]) || "--help".equals(args[0])) {
            printUsage();
            return;
        }

        File input = new File(args[0]);
        if (!input.isFile()) {
            throw new IOException("Input file does not exist: " + input.getAbsolutePath());
        }

        File output = args.length >= 2 ? new File(args[1]) : defaultOutputFile(input);
        ScoreData score = parseScore(input);
        byte[] midx = writeMidx(score);

        File parent = output.getAbsoluteFile().getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Could not create output directory: " + parent.getAbsolutePath());
        }

        FileOutputStream out = new FileOutputStream(output);
        try {
            out.write(midx);
        } finally {
            out.close();
        }

        System.out.println("Wrote " + output.getAbsolutePath());
        System.out.println("division=" + score.division
                + " tracks=" + score.tracksWithEvents().size()
                + " notes=" + score.noteCount
                + " microtonalOffsets=" + score.microtonalCount
                + " bytes=" + midx.length);
    }

    private static void printUsage() {
        System.out.println("Usage:");
        System.out.println("  javac tools/midi/MsczToMidx.java");
        System.out.println("  java -cp tools/midi MsczToMidx input.mscz [output.midx]");
    }

    private static File defaultOutputFile(File input) {
        String name = input.getName();
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            name = name.substring(0, dot);
        }
        return new File(input.getParentFile() == null ? new File(".") : input.getParentFile(), name + ".midx");
    }

    private static ScoreData parseScore(File input) throws Exception {
        Document doc = readMuseScoreDocument(input);
        Element root = doc.getDocumentElement();
        Element scoreElement = "Score".equals(root.getTagName()) ? root : firstDirectChild(root, "Score");
        if (scoreElement == null) {
            throw new IOException("No <Score> element found in " + input.getAbsolutePath());
        }

        ScoreData score = new ScoreData();
        score.division = intText(firstDirectChild(scoreElement, "Division"), DEFAULT_DIVISION);
        if (score.division <= 0) {
            score.division = DEFAULT_DIVISION;
        }

        parseParts(scoreElement, score);
        parseStaffBodies(scoreElement, score);

        if (score.tempoEvents.isEmpty()) {
            score.tempoEvents.add(new TempoEvent(0, DEFAULT_BPM));
        }
        if (score.timeSigEvents.isEmpty()) {
            score.timeSigEvents.add(new TimeSigEvent(0, DEFAULT_TIME_SIG_N, DEFAULT_TIME_SIG_D));
        }

        return score;
    }

    private static Document readMuseScoreDocument(File input) throws Exception {
        String lower = input.getName().toLowerCase(Locale.ROOT);
        byte[] xmlBytes;
        if (lower.endsWith(".mscz")) {
            xmlBytes = readMsczRootXml(input);
        } else {
            xmlBytes = readAll(new FileInputStream(input));
        }
        return parseXml(xmlBytes);
    }

    private static byte[] readMsczRootXml(File input) throws Exception {
        ZipFile zip = new ZipFile(input);
        try {
            String rootPath = null;
            ZipEntry container = zip.getEntry("META-INF/container.xml");
            if (container != null) {
                Document containerDoc = parseXml(readAll(zip.getInputStream(container)));
                NodeList rootFiles = containerDoc.getElementsByTagName("rootfile");
                for (int i = 0; i < rootFiles.getLength(); i++) {
                    Node node = rootFiles.item(i);
                    if (node instanceof Element) {
                        String candidate = ((Element) node).getAttribute("full-path");
                        if (candidate != null && candidate.length() > 0) {
                            rootPath = candidate;
                            break;
                        }
                    }
                }
            }

            ZipEntry scoreEntry = rootPath == null ? null : zip.getEntry(rootPath);
            if (scoreEntry == null) {
                List<? extends ZipEntry> entries = Collections.list(zip.entries());
                for (ZipEntry entry : entries) {
                    String name = entry.getName().toLowerCase(Locale.ROOT);
                    if (!entry.isDirectory() && name.endsWith(".mscx")) {
                        scoreEntry = entry;
                        break;
                    }
                }
            }
            if (scoreEntry == null) {
                throw new IOException("No .mscx score found inside " + input.getAbsolutePath());
            }
            return readAll(zip.getInputStream(scoreEntry));
        } finally {
            zip.close();
        }
    }

    private static Document parseXml(byte[] bytes) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        setXmlFeature(factory, "http://apache.org/xml/features/disallow-doctype-decl", true);
        setXmlFeature(factory, "http://xml.org/sax/features/external-general-entities", false);
        setXmlFeature(factory, "http://xml.org/sax/features/external-parameter-entities", false);
        setXmlFeature(factory, XMLConstants.FEATURE_SECURE_PROCESSING, true);
        DocumentBuilder builder = factory.newDocumentBuilder();
        return builder.parse(new InputSource(new ByteArrayInputStream(bytes)));
    }

    private static void setXmlFeature(DocumentBuilderFactory factory, String feature, boolean enabled) {
        try {
            factory.setFeature(feature, enabled);
        } catch (Exception ignored) {
            // Some older Java XML parsers do not expose every hardening flag.
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void parseParts(Element scoreElement, ScoreData score) {
        int partIndex = 0;
        int nextChannel = 0;
        for (Element part : directChildren(scoreElement, "Part")) {
            int program = parsePartProgram(part);
            int gateTimePercent = parsePartGateTime(part);
            String trackName = parsePartTrackName(part);
            String instrumentName = parsePartInstrumentName(part);
            List<Element> partStaffs = directChildren(part, "Staff");
            if (partStaffs.isEmpty()) {
                continue;
            }

            int channel = chooseChannel(nextChannel++);
            boolean firstStaffInPart = true;
            for (Element staffElement : partStaffs) {
                int staffId = intAttribute(staffElement, "id", score.staffInfos.size() + 1);
                StaffInfo info = new StaffInfo();
                info.staffId = staffId;
                info.partIndex = partIndex;
                info.program = clamp(program, 0, 127);
                info.channel = channel;
                info.gateTimePercent = gateTimePercent;
                info.writeProgramChange = firstStaffInPart;
                info.trackName = trackName;
                info.instrumentName = instrumentName;
                score.staffInfos.put(Integer.valueOf(staffId), info);
                firstStaffInPart = false;
            }
            partIndex++;
        }
    }

    private static int parsePartProgram(Element part) {
        Element instrument = firstDirectChild(part, "Instrument");
        if (instrument == null) {
            return 0;
        }
        Element channel = firstDirectChild(instrument, "Channel");
        Element program = channel == null ? null : firstDirectChild(channel, "program");
        if (program == null) {
            program = firstDirectDescendant(instrument, "program");
        }
        if (program == null) {
            return 0;
        }
        String value = program.getAttribute("value");
        if (value != null && value.length() > 0) {
            return parseInt(value, 0);
        }
        return parseInt(text(program), 0);
    }

    private static int parsePartGateTime(Element part) {
        Element instrument = firstDirectChild(part, "Instrument");
        if (instrument == null) {
            return 100;
        }
        for (Element articulation : directChildren(instrument, "Articulation")) {
            String name = articulation.getAttribute("name");
            if (name == null || name.length() == 0) {
                return clamp(intText(firstDirectChild(articulation, "gateTime"), 100), 1, 1000);
            }
        }
        return 100;
    }

    private static String parsePartTrackName(Element part) {
        String name = text(firstDirectChild(part, "trackName"));
        if (name.length() > 0) {
            return name;
        }
        Element instrument = firstDirectChild(part, "Instrument");
        return text(firstDirectChild(instrument, "trackName"));
    }

    private static String parsePartInstrumentName(Element part) {
        Element instrument = firstDirectChild(part, "Instrument");
        String longName = text(firstDirectChild(instrument, "longName"));
        if (longName.length() > 0) {
            return longName;
        }
        String shortName = text(firstDirectChild(instrument, "shortName"));
        if (shortName.length() > 0) {
            return shortName;
        }
        return text(firstDirectChild(instrument, "instrumentId"));
    }

    private static int chooseChannel(int index) {
        int channel = index % 15;
        return channel >= 9 ? channel + 1 : channel;
    }

    private static void parseStaffBodies(Element scoreElement, ScoreData score) {
        int fallbackStaffId = 1;
        List<Element> staffBodies = directChildren(scoreElement, "Staff");
        List<Long> measureStarts = buildMeasureStarts(staffBodies, score.division);
        for (Element staffBody : staffBodies) {
            int staffId = intAttribute(staffBody, "id", fallbackStaffId++);
            StaffInfo info = score.staffInfos.get(Integer.valueOf(staffId));
            if (info == null) {
                info = new StaffInfo();
                info.staffId = staffId;
                info.partIndex = score.staffInfos.size();
                info.program = 0;
                info.channel = chooseChannel(score.staffInfos.size());
                info.gateTimePercent = 100;
                info.writeProgramChange = true;
                info.trackName = "";
                info.instrumentName = "";
                score.staffInfos.put(Integer.valueOf(staffId), info);
            }
            TrackData track = score.trackForStaff(info);
            parseStaffBody(staffBody, score, track, measureStarts);
        }
    }

    private static List<Long> buildMeasureStarts(List<Element> staffBodies, int division) {
        List<List<Element>> measuresByStaff = new ArrayList<List<Element>>();
        int maxMeasures = 0;
        for (Element staffBody : staffBodies) {
            List<Element> measures = directChildren(staffBody, "Measure");
            measuresByStaff.add(measures);
            if (measures.size() > maxMeasures) {
                maxMeasures = measures.size();
            }
        }

        List<Long> starts = new ArrayList<Long>();
        long tick = 0;
        int currentSigN = DEFAULT_TIME_SIG_N;
        int currentSigD = DEFAULT_TIME_SIG_D;
        for (int measureIndex = 0; measureIndex < maxMeasures; measureIndex++) {
            starts.add(Long.valueOf(tick));
            TimeSigEvent signature = firstTimeSigAtMeasure(measuresByStaff, measureIndex);
            if (signature != null) {
                currentSigN = signature.numerator;
                currentSigD = signature.denominator;
            }
            tick += Math.max(1, measureLengthAtIndex(measuresByStaff, measureIndex, division, currentSigN, currentSigD));
        }
        return starts;
    }

    private static TimeSigEvent firstTimeSigAtMeasure(List<List<Element>> measuresByStaff, int measureIndex) {
        for (List<Element> measures : measuresByStaff) {
            if (measureIndex >= measures.size()) {
                continue;
            }
            Element timeSig = firstTimeSigInMeasure(measures.get(measureIndex));
            if (timeSig != null) {
                int n = intText(firstDirectChild(timeSig, "sigN"), DEFAULT_TIME_SIG_N);
                int d = intText(firstDirectChild(timeSig, "sigD"), DEFAULT_TIME_SIG_D);
                if (n > 0 && d > 0) {
                    return new TimeSigEvent(0, n, d);
                }
            }
        }
        return null;
    }

    private static Element firstTimeSigInMeasure(Element measure) {
        for (Element voice : directChildren(measure, "voice")) {
            Element timeSig = firstDirectChild(voice, "TimeSig");
            if (timeSig != null) {
                return timeSig;
            }
        }
        return null;
    }

    private static long measureLengthAtIndex(
            List<List<Element>> measuresByStaff,
            int measureIndex,
            int division,
            int sigN,
            int sigD
    ) {
        long signatureTicks = ticksForTimeSignature(division, sigN, sigD);
        boolean irregular = false;
        long irregularTicks = 0;
        for (List<Element> measures : measuresByStaff) {
            if (measureIndex >= measures.size()) {
                continue;
            }
            Element measure = measures.get(measureIndex);
            if (hasAttributeValue(measure, "len")) {
                long explicitTicks = ratioTicks(measure.getAttribute("len"), division);
                if (explicitTicks > 0) {
                    return explicitTicks;
                }
            }
            if (intText(firstDirectChild(measure, "irregular"), 0) != 0) {
                irregular = true;
                irregularTicks = Math.max(irregularTicks, measureContentTicks(measure, division, signatureTicks));
            }
        }
        if (irregular && irregularTicks > 0) {
            return irregularTicks;
        }
        return signatureTicks;
    }

    private static long measureContentTicks(Element measure, int division, long measureTicks) {
        long maxTicks = 0;
        for (Element voice : directChildren(measure, "voice")) {
            long tick = 0;
            double tupletRatio = 1.0;
            int tupletRemaining = 0;
            NodeList children = voice.getChildNodes();
            for (int i = 0; i < children.getLength(); i++) {
                Node node = children.item(i);
                if (!(node instanceof Element)) {
                    continue;
                }
                Element element = (Element) node;
                String tag = element.getTagName();
                if ("Tuplet".equals(tag)) {
                    int normal = intText(firstDirectChild(element, "normalNotes"), 0);
                    int actual = intText(firstDirectChild(element, "actualNotes"), 0);
                    if (normal > 0 && actual > 0) {
                        tupletRatio = ((double) normal) / ((double) actual);
                        tupletRemaining = actual;
                    }
                } else if ("Rest".equals(tag) || "Chord".equals(tag)) {
                    tick += Math.max(0, durationTicks(element, division, tupletRatio, measureTicks));
                    if (tupletRemaining > 0) {
                        tupletRemaining--;
                        if (tupletRemaining <= 0) {
                            tupletRatio = 1.0;
                        }
                    }
                }
            }
            maxTicks = Math.max(maxTicks, tick);
        }
        return maxTicks;
    }

    private static void parseStaffBody(Element staffBody, ScoreData score, TrackData track, List<Long> measureStarts) {
        List<Element> measures = directChildren(staffBody, "Measure");
        Map<Integer, VoiceState> voiceStates = new HashMap<Integer, VoiceState>();
        for (int measureIndex = 0; measureIndex < measures.size(); measureIndex++) {
            Element measure = measures.get(measureIndex);
            long measureStart = measureIndex < measureStarts.size() ? measureStarts.get(measureIndex).longValue() : 0;
            long nextMeasureStart = measureIndex + 1 < measureStarts.size()
                    ? measureStarts.get(measureIndex + 1).longValue()
                    : measureStart + score.division;
            long measureTicks = Math.max(1, nextMeasureStart - measureStart);
            List<Element> voices = directChildren(measure, "voice");

            if (voices.isEmpty()) {
                continue;
            }

            for (int voiceIndex = 0; voiceIndex < voices.size(); voiceIndex++) {
                VoiceState state = voiceStates.get(Integer.valueOf(voiceIndex));
                if (state == null) {
                    state = new VoiceState();
                    state.velocity = DEFAULT_VELOCITY;
                    voiceStates.put(Integer.valueOf(voiceIndex), state);
                }
                state.tick = measureStart;
                state.measureTicks = measureTicks;
                state.tupletRatio = 1.0;
                state.tupletRemaining = 0;
                parseVoice(voices.get(voiceIndex), score, track, state, voiceIndex);
            }
        }

        for (VoiceState state : voiceStates.values()) {
            for (NotePlayback playback : state.activeTies.values()) {
                emitPlayback(track, score, playback);
            }
            state.activeTies.clear();
        }
    }

    private static void parseVoice(Element voice, ScoreData score, TrackData track, VoiceState state, int voiceIndex) {
        NodeList children = voice.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (!(node instanceof Element)) {
                continue;
            }
            Element element = (Element) node;
            String tag = element.getTagName();
            if ("Tempo".equals(tag)) {
                double tempo = doubleText(firstDirectChild(element, "tempo"), -1.0);
                if (tempo > 0.0) {
                    score.tempoEvents.add(new TempoEvent(state.tick, tempo * 60.0));
                }
            } else if ("TimeSig".equals(tag)) {
                int n = intText(firstDirectChild(element, "sigN"), DEFAULT_TIME_SIG_N);
                int d = intText(firstDirectChild(element, "sigD"), DEFAULT_TIME_SIG_D);
                if (n > 0 && d > 0) {
                    state.lastTimeSigN = n;
                    state.lastTimeSigD = d;
                    score.timeSigEvents.add(new TimeSigEvent(state.tick, n, d));
                }
            } else if ("Dynamic".equals(tag)) {
                state.velocity = clamp(intText(firstDirectChild(element, "velocity"), state.velocity), 1, 127);
            } else if ("location".equals(tag)) {
                state.tick += locationTicks(element, score.division);
            } else if ("Tuplet".equals(tag)) {
                int normal = intText(firstDirectChild(element, "normalNotes"), 0);
                int actual = intText(firstDirectChild(element, "actualNotes"), 0);
                if (normal > 0 && actual > 0) {
                    state.tupletRatio = ((double) normal) / ((double) actual);
                    state.tupletRemaining = actual;
                }
            } else if ("Rest".equals(tag)) {
                long duration = durationTicks(element, score.division, state.tupletRatio, state.measureTicks);
                state.tick += Math.max(0, duration);
                consumeTupletSlot(state);
            } else if ("Chord".equals(tag)) {
                long nominalDuration = durationTicks(element, score.division, state.tupletRatio, state.measureTicks);
                appendChordNotes(element, score, track, state, voiceIndex, nominalDuration);
                state.tick += Math.max(0, nominalDuration);
                consumeTupletSlot(state);
            }
        }
    }

    private static void appendChordNotes(
            Element chord,
            ScoreData score,
            TrackData track,
            VoiceState state,
            int voiceIndex,
            long nominalDuration
    ) {
        List<EventTiming> timings = eventTimings(chord, nominalDuration);
        List<Element> notes = directChildren(chord, "Note");
        for (Element note : notes) {
            int xmlPitch = intText(firstDirectChild(note, "pitch"), -1);
            if (xmlPitch < 0) {
                continue;
            }
            double tuning = doubleText(firstDirectChild(note, "tuning"), 0.0);
            int velocity = noteVelocity(note, state.velocity);
            boolean tiePrev = hasTieEndpoint(note, "prev");
            boolean tieNext = hasTieEndpoint(note, "next");

            for (EventTiming timing : timings) {
                double eventPitchDelta = timing.pitchDelta;
                NormalizedPitch normalized = normalizeMidxPitchCents(xmlPitch + eventPitchDelta, tuning);
                int nativePitch = clamp((int) Math.round(xmlPitch + eventPitchDelta), 0, 127);
                long startTick = state.tick + timing.offsetTicks;
                long endTick = Math.max(startTick + 1, startTick + timing.lengthTicks);
                TieKey key = new TieKey(track.staffId, voiceIndex, xmlPitch, Math.round(tuning * 1000.0) / 1000.0);

                if (tiePrev) {
                    NotePlayback active = state.activeTies.get(key);
                    if (active != null) {
                        active.endTick = Math.max(active.endTick, endTick);
                        if (!tieNext) {
                            state.activeTies.remove(key);
                            emitPlayback(track, score, active);
                        }
                        continue;
                    }
                    if (!tieNext) {
                        continue;
                    }
                }

                NotePlayback playback = new NotePlayback();
                playback.startTick = startTick;
                playback.endTick = endTick;
                playback.pitch = normalized.pitch;
                playback.nativePitch = nativePitch;
                playback.cents = normalized.cents;
                playback.velocity = velocity;

                if (tieNext) {
                    state.activeTies.put(key, playback);
                } else {
                    emitPlayback(track, score, playback);
                }
            }
        }
    }

    private static void emitPlayback(TrackData track, ScoreData score, NotePlayback playback) {
        playback.pitch = clamp(playback.pitch, 0, 127);
        playback.nativePitch = clamp(playback.nativePitch, 0, 127);
        playback.velocity = clamp(playback.velocity, 1, 127);
        long gatedEndTick = gatedEndTick(playback.startTick, playback.endTick, track.gateTimePercent);
        track.events.add(MidiEvent.noteOn(playback.startTick, playback.pitch, playback.nativePitch, playback.velocity, playback.cents));
        track.events.add(MidiEvent.noteOff(gatedEndTick, playback.nativePitch));
        score.noteCount++;
        if (encodeCentOffset(playback.cents) != 0) {
            score.microtonalCount++;
        }
    }

    private static long gatedEndTick(long startTick, long endTick, int gateTimePercent) {
        long duration = Math.max(1, endTick - startTick);
        long gatedDuration = (long) Math.floor(duration * clamp(gateTimePercent, 1, 1000) / 100.0) - 1;
        return startTick + Math.max(1, gatedDuration);
    }

    private static List<EventTiming> eventTimings(Element chord, long nominalDuration) {
        Element events = firstDirectChild(chord, "Events");
        if (events == null) {
            List<EventTiming> single = new ArrayList<EventTiming>();
            single.add(new EventTiming(0, Math.max(1, nominalDuration), 0.0));
            return single;
        }

        List<EventTiming> out = new ArrayList<EventTiming>();
        for (Element event : directChildren(events, "Event")) {
            double ontime = doubleText(firstDirectChild(event, "ontime"), 0.0);
            double len = doubleText(firstDirectChild(event, "len"), 1000.0);
            double pitch = doubleText(firstDirectChild(event, "pitch"), 0.0);
            long offsetTicks = Math.round(nominalDuration * ontime / 1000.0);
            long lengthTicks = Math.max(1, Math.round(nominalDuration * len / 1000.0));
            out.add(new EventTiming(offsetTicks, lengthTicks, pitch));
        }
        if (out.isEmpty()) {
            out.add(new EventTiming(0, Math.max(1, nominalDuration), 0.0));
        }
        return out;
    }

    private static int noteVelocity(Element note, int inheritedVelocity) {
        Element velocityElement = firstDirectChild(note, "velocity");
        Element veloTypeElement = firstDirectChild(note, "veloType");
        Element veloOffsetElement = firstDirectChild(note, "veloOffset");

        int velocity = inheritedVelocity;
        if (velocityElement != null) {
            velocity = intText(velocityElement, velocity);
        } else if (veloOffsetElement != null) {
            velocity += intText(veloOffsetElement, 0);
        }

        String veloType = veloTypeElement == null ? "" : text(veloTypeElement);
        if ("offset".equalsIgnoreCase(veloType) && velocityElement != null) {
            velocity = inheritedVelocity + intText(velocityElement, 0);
        }
        return clamp(velocity, 1, 127);
    }

    private static boolean hasTieEndpoint(Element note, String endpoint) {
        for (Element spanner : directChildren(note, "Spanner")) {
            if ("Tie".equals(spanner.getAttribute("type")) && firstDirectChild(spanner, endpoint) != null) {
                return true;
            }
        }
        return false;
    }

    private static long locationTicks(Element location, int division) {
        Element fractions = firstDirectChild(location, "fractions");
        if (fractions == null) {
            return 0;
        }
        return ratioTicks(text(fractions), division);
    }

    private static long ticksForTimeSignature(int division, int sigN, int sigD) {
        if (sigN <= 0 || sigD <= 0) {
            sigN = DEFAULT_TIME_SIG_N;
            sigD = DEFAULT_TIME_SIG_D;
        }
        return Math.round(division * 4.0 * sigN / sigD);
    }

    private static long durationTicks(Element element, int division, double tupletRatio, long measureTicks) {
        Element explicitDuration = firstDirectChild(element, "duration");
        if (explicitDuration != null) {
            long ticks = ratioTicks(text(explicitDuration), division);
            if (ticks > 0) {
                return Math.max(1, Math.round(ticks * tupletRatio));
            }
        }

        String durationType = text(firstDirectChild(element, "durationType"));
        long base = durationTypeTicks(durationType, division, measureTicks);
        int dots = intText(firstDirectChild(element, "dots"), 0);
        double multiplier = 1.0;
        double add = 0.5;
        for (int i = 0; i < dots; i++) {
            multiplier += add;
            add *= 0.5;
        }
        return Math.max(1, Math.round(base * multiplier * tupletRatio));
    }

    private static long durationTypeTicks(String durationType, int division, long measureTicks) {
        if (durationType == null) {
            return division;
        }
        String type = durationType.trim().toLowerCase(Locale.ROOT);
        if ("measure".equals(type)) {
            return measureTicks > 0 ? measureTicks : division * 4L;
        }
        if ("longa".equals(type)) {
            return division * 16L;
        }
        if ("breve".equals(type)) {
            return division * 8L;
        }
        if ("whole".equals(type)) {
            return division * 4L;
        }
        if ("half".equals(type)) {
            return division * 2L;
        }
        if ("quarter".equals(type)) {
            return division;
        }
        if ("eighth".equals(type)) {
            return Math.max(1, division / 2L);
        }
        if ("16th".equals(type)) {
            return Math.max(1, division / 4L);
        }
        if ("32nd".equals(type)) {
            return Math.max(1, division / 8L);
        }
        if ("64th".equals(type)) {
            return Math.max(1, division / 16L);
        }
        if ("128th".equals(type)) {
            return Math.max(1, division / 32L);
        }
        if ("256th".equals(type)) {
            return Math.max(1, division / 64L);
        }
        if (type.endsWith("th")) {
            int denominator = parseInt(type.substring(0, type.length() - 2), 4);
            if (denominator > 0) {
                return Math.max(1, Math.round(division * 4.0 / denominator));
            }
        }
        return division;
    }

    private static long ratioTicks(String text, int division) {
        if (text == null) {
            return 0;
        }
        String value = text.trim();
        if (value.length() == 0) {
            return 0;
        }
        int slash = value.indexOf('/');
        if (slash >= 0) {
            double numerator = parseDouble(value.substring(0, slash), 0.0);
            double denominator = parseDouble(value.substring(slash + 1), 1.0);
            if (denominator != 0.0) {
                return Math.round(division * 4.0 * numerator / denominator);
            }
        }
        return Math.round(parseDouble(value, 0.0) * division);
    }

    private static void consumeTupletSlot(VoiceState state) {
        if (state.tupletRemaining > 0) {
            state.tupletRemaining--;
            if (state.tupletRemaining <= 0) {
                state.tupletRatio = 1.0;
            }
        }
    }

    private static NormalizedPitch normalizeMidxPitchCents(double pitch, double cents) {
        if (Double.isNaN(pitch) || Double.isInfinite(pitch)) {
            pitch = 0.0;
        }
        if (Double.isNaN(cents) || Double.isInfinite(cents)) {
            cents = 0.0;
        }

        int targetPitch = (int) Math.round(pitch);
        double residualCents = cents + (pitch - targetPitch) * 100.0;
        int guard = 0;

        while (residualCents > MIDX_SAFE_CENT_RANGE && guard < 512) {
            targetPitch += 1;
            residualCents -= 100.0;
            guard++;
        }
        while (residualCents < -MIDX_SAFE_CENT_RANGE && guard < 512) {
            targetPitch -= 1;
            residualCents += 100.0;
            guard++;
        }
        if (Math.abs(residualCents) < 0.000001) {
            residualCents = 0.0;
        }
        NormalizedPitch out = new NormalizedPitch();
        out.pitch = clamp(targetPitch, 0, 127);
        out.cents = residualCents;
        return out;
    }

    private static int encodeCentOffset(double cents) {
        if (Double.isNaN(cents) || Double.isInfinite(cents)) {
            cents = 0.0;
        }
        int sign = cents < 0.0 ? 0x8000 : 0;
        int magnitude = (int) Math.round(Math.abs(cents) / MIDX_CENT_RANGE * MIDX_OFFSET_STEPS);
        if (magnitude > 0x7FFF) {
            magnitude = 0x7FFF;
        }
        return sign | magnitude;
    }

    private static byte[] writeMidx(ScoreData score) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        List<TrackData> tracks = score.tracksWithEvents();
        writeChunk(out, "MThd", headerData(score.division, Math.max(1, tracks.size())));
        if (tracks.isEmpty()) {
            writeChunk(out, "MTrk", mergedTrackData(null, score, true));
        } else {
            for (int i = 0; i < tracks.size(); i++) {
                writeChunk(out, "MTrk", mergedTrackData(tracks.get(i), score, i == 0));
            }
        }
        return out.toByteArray();
    }

    private static byte[] headerData(int division, int trackCount) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeU16(out, 1);
        writeU16(out, trackCount);
        writeU16(out, clamp(division, 1, 0x7FFF));
        return out.toByteArray();
    }

    private static List<MetaTickEvent> metaEvents(ScoreData score) {
        List<MetaTickEvent> events = new ArrayList<MetaTickEvent>();
        for (TempoEvent tempo : score.tempoEvents) {
            events.add(new MetaTickEvent(tempo.tick, 0, tempo));
        }
        for (TimeSigEvent sig : score.timeSigEvents) {
            events.add(new MetaTickEvent(sig.tick, 1, sig));
        }
        Collections.sort(events, new Comparator<MetaTickEvent>() {
            public int compare(MetaTickEvent a, MetaTickEvent b) {
                if (a.tick != b.tick) {
                    return a.tick < b.tick ? -1 : 1;
                }
                return a.order - b.order;
            }
        });
        return events;
    }

    private static void writeMetaEvent(ByteArrayOutputStream out, MetaTickEvent event) throws IOException {
        if (event.payload instanceof TempoEvent) {
            TempoEvent tempo = (TempoEvent) event.payload;
            int mpqn = (int) Math.round(60000000.0 / Math.max(1.0, Math.min(1000.0, tempo.bpm)));
            out.write(0xFF);
            out.write(0x51);
            out.write(0x03);
            writeU24(out, mpqn);
        } else if (event.payload instanceof TimeSigEvent) {
            TimeSigEvent sig = (TimeSigEvent) event.payload;
            out.write(0xFF);
            out.write(0x58);
            out.write(0x04);
            out.write(clamp(sig.numerator, 1, 255));
            out.write(timeSigDenominatorPower(sig.denominator));
            out.write(24);
            out.write(8);
        }
    }

    private static int timeSigDenominatorPower(int denominator) {
        int value = 1;
        int power = 0;
        while (value < denominator && power < 8) {
            value <<= 1;
            power++;
        }
        return power;
    }

    private static byte[] mergedTrackData(TrackData track, ScoreData score, boolean includeMeta) throws IOException {
        List<TrackTickEvent> events = new ArrayList<TrackTickEvent>();
        if (includeMeta) {
            for (MetaTickEvent event : metaEvents(score)) {
                events.add(TrackTickEvent.meta(event));
            }
        }
        if (track != null) {
            for (MidiEvent event : track.events) {
                events.add(TrackTickEvent.midi(event));
            }
        }
        Collections.sort(events, new Comparator<TrackTickEvent>() {
            public int compare(TrackTickEvent a, TrackTickEvent b) {
                if (a.tick != b.tick) {
                    return a.tick < b.tick ? -1 : 1;
                }
                if (a.order != b.order) {
                    return a.order - b.order;
                }
                return a.pitch - b.pitch;
            }
        });

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (track != null && track.trackName != null && track.trackName.length() > 0) {
            writeVlq(out, 0);
            writeTextMeta(out, 0x03, track.trackName);
        }
        if (track != null && track.instrumentName != null && track.instrumentName.length() > 0) {
            writeVlq(out, 0);
            writeTextMeta(out, 0x04, track.instrumentName);
        }

        if (track != null && track.writeProgramChange) {
            writeVlq(out, 0);
            out.write(0xC0 | (track.channel & 0x0F));
            out.write(track.program & 0x7F);
        }

        long previousTick = 0;
        for (TrackTickEvent event : events) {
            long tick = Math.max(0, event.tick);
            writeVlq(out, tick - previousTick);
            if (event.meta != null) {
                writeMetaEvent(out, event.meta);
            } else {
                MidiEvent midi = event.midi;
                if (midi.kind == MidiEvent.KIND_NOTE_ON && encodeCentOffset(midi.cents) != 0) {
                    writeMidxOffsetExtension(out, midi.pitch, midi.cents);
                    writeVlq(out, 0);
                }
                if (midi.kind == MidiEvent.KIND_NOTE_OFF) {
                    out.write(0x80 | (track.channel & 0x0F));
                    out.write(midi.nativePitch & 0x7F);
                    out.write(0x00);
                } else {
                    out.write(0x90 | (track.channel & 0x0F));
                    out.write(midi.nativePitch & 0x7F);
                    out.write(midi.velocity & 0x7F);
                }
            }
            previousTick = tick;
        }

        writeVlq(out, 0);
        out.write(0xFF);
        out.write(0x2F);
        out.write(0x00);
        return out.toByteArray();
    }

    private static void writeMidxOffsetExtension(ByteArrayOutputStream out, int pitch, double cents) throws IOException {
        out.write(0xFF);
        out.write(MIDX_META_TYPE);
        out.write(MIDX_PAYLOAD_LEN);
        out.write(MIDX_EXPERIMENTAL_MANUFACTURER_ID);
        out.write('X');
        out.write('T');
        out.write(MIDX_PITCHED_OFFSET_RECORD_TYPE);
        out.write(clamp(pitch, 0, 127));
        writeU16(out, encodeCentOffset(cents));
    }

    private static void writeTextMeta(ByteArrayOutputStream out, int metaType, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        out.write(0xFF);
        out.write(metaType & 0x7F);
        writeVlq(out, bytes.length);
        out.write(bytes);
    }

    private static void writeChunk(ByteArrayOutputStream out, String type, byte[] data) throws IOException {
        for (int i = 0; i < type.length(); i++) {
            out.write(type.charAt(i) & 0xFF);
        }
        writeU32(out, data.length);
        out.write(data);
    }

    private static void writeU16(ByteArrayOutputStream out, int value) {
        out.write((value >>> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    private static void writeU24(ByteArrayOutputStream out, int value) {
        out.write((value >>> 16) & 0xFF);
        out.write((value >>> 8) & 0xFF);
        out.write(value & 0xFF);
    }

    private static void writeU32(ByteArrayOutputStream out, long value) {
        out.write((int) ((value >>> 24) & 0xFF));
        out.write((int) ((value >>> 16) & 0xFF));
        out.write((int) ((value >>> 8) & 0xFF));
        out.write((int) (value & 0xFF));
    }

    private static void writeVlq(ByteArrayOutputStream out, long value) {
        value = Math.max(0, Math.min(0x0FFFFFFFL, value));
        int[] stack = new int[5];
        int count = 0;
        stack[count++] = (int) (value & 0x7F);
        value >>>= 7;
        while (value > 0) {
            stack[count++] = (int) ((value & 0x7F) | 0x80);
            value >>>= 7;
        }
        for (int i = count - 1; i >= 0; i--) {
            out.write(stack[i]);
        }
    }

    private static Element firstDirectChild(Element parent, String tag) {
        if (parent == null) {
            return null;
        }
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (node instanceof Element && tag.equals(((Element) node).getTagName())) {
                return (Element) node;
            }
        }
        return null;
    }

    private static List<Element> directChildren(Element parent, String tag) {
        List<Element> out = new ArrayList<Element>();
        if (parent == null) {
            return out;
        }
        NodeList children = parent.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (node instanceof Element && (tag == null || tag.equals(((Element) node).getTagName()))) {
                out.add((Element) node);
            }
        }
        return out;
    }

    private static Element firstDirectDescendant(Element parent, String tag) {
        if (parent == null) {
            return null;
        }
        NodeList children = parent.getElementsByTagName(tag);
        for (int i = 0; i < children.getLength(); i++) {
            Node node = children.item(i);
            if (node instanceof Element) {
                return (Element) node;
            }
        }
        return null;
    }

    private static String text(Element element) {
        return element == null ? "" : element.getTextContent().trim();
    }

    private static int intText(Element element, int fallback) {
        return parseInt(text(element), fallback);
    }

    private static double doubleText(Element element, double fallback) {
        return parseDouble(text(element), fallback);
    }

    private static int intAttribute(Element element, String name, int fallback) {
        if (element == null) {
            return fallback;
        }
        NamedNodeMap attrs = element.getAttributes();
        Node attr = attrs == null ? null : attrs.getNamedItem(name);
        return attr == null ? fallback : parseInt(attr.getNodeValue(), fallback);
    }

    private static boolean hasAttributeValue(Element element, String name) {
        if (element == null) {
            return false;
        }
        String value = element.getAttribute(name);
        return value != null && value.length() > 0;
    }

    private static int parseInt(String value, int fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return (int) Math.round(Double.parseDouble(value.trim()));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static double parseDouble(String value, double fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return Double.parseDouble(value.trim());
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static int clamp(int value, int min, int max) {
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    private static final class ScoreData {
        int division = DEFAULT_DIVISION;
        int noteCount = 0;
        int microtonalCount = 0;
        final Map<Integer, StaffInfo> staffInfos = new LinkedHashMap<Integer, StaffInfo>();
        final Map<Integer, TrackData> tracks = new TreeMap<Integer, TrackData>();
        final List<TempoEvent> tempoEvents = new ArrayList<TempoEvent>();
        final List<TimeSigEvent> timeSigEvents = new ArrayList<TimeSigEvent>();

        TrackData trackForStaff(StaffInfo info) {
            TrackData track = tracks.get(Integer.valueOf(info.staffId));
            if (track == null) {
                track = new TrackData();
                track.staffId = info.staffId;
                track.partIndex = info.partIndex;
                track.program = info.program;
                track.channel = info.channel;
                track.gateTimePercent = info.gateTimePercent;
                track.writeProgramChange = info.writeProgramChange;
                track.trackName = info.trackName;
                track.instrumentName = info.instrumentName;
                tracks.put(Integer.valueOf(info.staffId), track);
            }
            return track;
        }

        List<TrackData> tracksWithEvents() {
            List<TrackData> out = new ArrayList<TrackData>();
            for (TrackData track : tracks.values()) {
                if (!track.events.isEmpty()) {
                    out.add(track);
                }
            }
            return out;
        }
    }

    private static final class StaffInfo {
        int staffId;
        int partIndex;
        int program;
        int channel;
        int gateTimePercent;
        boolean writeProgramChange;
        String trackName;
        String instrumentName;
    }

    private static final class TrackData {
        int staffId;
        int partIndex;
        int program;
        int channel;
        int gateTimePercent;
        boolean writeProgramChange;
        String trackName;
        String instrumentName;
        final List<MidiEvent> events = new ArrayList<MidiEvent>();
    }

    private static final class VoiceState {
        long tick;
        long measureTicks;
        int velocity;
        double tupletRatio;
        int tupletRemaining;
        int lastTimeSigN;
        int lastTimeSigD;
        final Map<TieKey, NotePlayback> activeTies = new HashMap<TieKey, NotePlayback>();
    }

    private static final class TempoEvent {
        final long tick;
        final double bpm;

        TempoEvent(long tick, double bpm) {
            this.tick = tick;
            this.bpm = bpm;
        }
    }

    private static final class TimeSigEvent {
        final long tick;
        final int numerator;
        final int denominator;

        TimeSigEvent(long tick, int numerator, int denominator) {
            this.tick = tick;
            this.numerator = numerator;
            this.denominator = denominator;
        }
    }

    private static final class MetaTickEvent {
        final long tick;
        final int order;
        final Object payload;

        MetaTickEvent(long tick, int order, Object payload) {
            this.tick = tick;
            this.order = order;
            this.payload = payload;
        }
    }

    private static final class TrackTickEvent {
        final long tick;
        final int order;
        final int pitch;
        final MetaTickEvent meta;
        final MidiEvent midi;

        private TrackTickEvent(long tick, int order, int pitch, MetaTickEvent meta, MidiEvent midi) {
            this.tick = tick;
            this.order = order;
            this.pitch = pitch;
            this.meta = meta;
            this.midi = midi;
        }

        static TrackTickEvent meta(MetaTickEvent event) {
            return new TrackTickEvent(event.tick, event.order, 0, event, null);
        }

        static TrackTickEvent midi(MidiEvent event) {
            int order = event.kind == MidiEvent.KIND_NOTE_OFF ? 10 : 20;
            return new TrackTickEvent(event.tick, order, event.pitch, null, event);
        }
    }

    private static final class MidiEvent {
        static final int KIND_NOTE_OFF = 0;
        static final int KIND_NOTE_ON = 1;

        final long tick;
        final int kind;
        final int pitch;
        final int nativePitch;
        final int velocity;
        final double cents;

        private MidiEvent(long tick, int kind, int pitch, int nativePitch, int velocity, double cents) {
            this.tick = tick;
            this.kind = kind;
            this.pitch = pitch;
            this.nativePitch = nativePitch;
            this.velocity = velocity;
            this.cents = cents;
        }

        static MidiEvent noteOn(long tick, int pitch, int nativePitch, int velocity, double cents) {
            return new MidiEvent(tick, KIND_NOTE_ON, pitch, nativePitch, velocity, cents);
        }

        static MidiEvent noteOff(long tick, int nativePitch) {
            return new MidiEvent(tick, KIND_NOTE_OFF, nativePitch, nativePitch, 0, 0.0);
        }
    }

    private static final class NotePlayback {
        long startTick;
        long endTick;
        int pitch;
        int nativePitch;
        double cents;
        int velocity;
    }

    private static final class NormalizedPitch {
        int pitch;
        double cents;
    }

    private static final class EventTiming {
        final long offsetTicks;
        final long lengthTicks;
        final double pitchDelta;

        EventTiming(long offsetTicks, long lengthTicks, double pitchDelta) {
            this.offsetTicks = offsetTicks;
            this.lengthTicks = lengthTicks;
            this.pitchDelta = pitchDelta;
        }
    }

    private static final class TieKey {
        final int staffId;
        final int voiceIndex;
        final int pitch;
        final double tuning;

        TieKey(int staffId, int voiceIndex, int pitch, double tuning) {
            this.staffId = staffId;
            this.voiceIndex = voiceIndex;
            this.pitch = pitch;
            this.tuning = tuning;
        }

        public boolean equals(Object other) {
            if (!(other instanceof TieKey)) {
                return false;
            }
            TieKey that = (TieKey) other;
            return this.staffId == that.staffId
                    && this.voiceIndex == that.voiceIndex
                    && this.pitch == that.pitch
                    && Double.compare(this.tuning, that.tuning) == 0;
        }

        public int hashCode() {
            long bits = Double.doubleToLongBits(tuning);
            int result = staffId;
            result = 31 * result + voiceIndex;
            result = 31 * result + pitch;
            result = 31 * result + (int) (bits ^ (bits >>> 32));
            return result;
        }
    }
}
