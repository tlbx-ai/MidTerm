namespace Ai.Tlbx.MidTerm.Settings;

public sealed class TerminalColorSchemeDefinition
{
    public string Name { get; set; } = "";
    public string Background { get; set; } = "#0C0C0C";
    public string Foreground { get; set; } = "#F2F2F2";
    public string Cursor { get; set; } = "#F2F2F2";
    public string CursorAccent { get; set; } = "#0C0C0C";
    public string SelectionBackground { get; set; } = "#2D3044";
    public string ScrollbarSliderBackground { get; set; } = "rgba(58, 62, 82, 0.5)";
    public string ScrollbarSliderHoverBackground { get; set; } = "rgba(123, 162, 247, 0.5)";
    public string ScrollbarSliderActiveBackground { get; set; } = "rgba(123, 162, 247, 0.7)";
    public string Black { get; set; } = "#0C0C0C";
    public string Red { get; set; } = "#D61D2D";
    public string Green { get; set; } = "#19B414";
    public string Yellow { get; set; } = "#D6AF00";
    public string Blue { get; set; } = "#0050FF";
    public string Magenta { get; set; } = "#A01DB1";
    public string Cyan { get; set; } = "#46ADED";
    public string White { get; set; } = "#3A96DD";
    public string BrightBlack { get; set; } = "#767676";
    public string BrightRed { get; set; } = "#F45B69";
    public string BrightGreen { get; set; } = "#27DE20";
    public string BrightYellow { get; set; } = "#FFF2AE";
    public string BrightBlue { get; set; } = "#5A91FF";
    public string BrightMagenta { get; set; } = "#D400BC";
    public string BrightCyan { get; set; } = "#78F0F0";
    public string BrightWhite { get; set; } = "#F2F2F2";

    internal static TerminalColorSchemeDefinition? Normalize(TerminalColorSchemeDefinition? scheme)
    {
        if (scheme is null)
        {
            return null;
        }

        var name = NormalizeRequiredString(scheme.Name, fallback: "");
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        return new TerminalColorSchemeDefinition
        {
            Name = name,
            Background = NormalizeRequiredString(scheme.Background, "#0C0C0C"),
            Foreground = NormalizeRequiredString(scheme.Foreground, "#F2F2F2"),
            Cursor = NormalizeRequiredString(scheme.Cursor, "#F2F2F2"),
            CursorAccent = NormalizeRequiredString(scheme.CursorAccent, "#0C0C0C"),
            SelectionBackground = NormalizeRequiredString(scheme.SelectionBackground, "#2D3044"),
            ScrollbarSliderBackground = NormalizeRequiredString(scheme.ScrollbarSliderBackground, "rgba(58, 62, 82, 0.5)"),
            ScrollbarSliderHoverBackground = NormalizeRequiredString(scheme.ScrollbarSliderHoverBackground, "rgba(123, 162, 247, 0.5)"),
            ScrollbarSliderActiveBackground = NormalizeRequiredString(scheme.ScrollbarSliderActiveBackground, "rgba(123, 162, 247, 0.7)"),
            Black = NormalizeRequiredString(scheme.Black, "#0C0C0C"),
            Red = NormalizeRequiredString(scheme.Red, "#D61D2D"),
            Green = NormalizeRequiredString(scheme.Green, "#19B414"),
            Yellow = NormalizeRequiredString(scheme.Yellow, "#D6AF00"),
            Blue = NormalizeRequiredString(scheme.Blue, "#0050FF"),
            Magenta = NormalizeRequiredString(scheme.Magenta, "#A01DB1"),
            Cyan = NormalizeRequiredString(scheme.Cyan, "#46ADED"),
            White = NormalizeRequiredString(scheme.White, "#3A96DD"),
            BrightBlack = NormalizeRequiredString(scheme.BrightBlack, "#767676"),
            BrightRed = NormalizeRequiredString(scheme.BrightRed, "#F45B69"),
            BrightGreen = NormalizeRequiredString(scheme.BrightGreen, "#27DE20"),
            BrightYellow = NormalizeRequiredString(scheme.BrightYellow, "#FFF2AE"),
            BrightBlue = NormalizeRequiredString(scheme.BrightBlue, "#5A91FF"),
            BrightMagenta = NormalizeRequiredString(scheme.BrightMagenta, "#D400BC"),
            BrightCyan = NormalizeRequiredString(scheme.BrightCyan, "#78F0F0"),
            BrightWhite = NormalizeRequiredString(scheme.BrightWhite, "#F2F2F2")
        };
    }

    private static string NormalizeRequiredString(string? value, string fallback)
    {
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}
